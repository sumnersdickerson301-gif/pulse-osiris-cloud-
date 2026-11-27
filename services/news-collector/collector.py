"""OSIRIS collector prototype: snapshots public news into a durable SQLite archive.

Deploy as ONE Railway replica with /data mounted to a persistent volume.
The HTTP archive is disabled unless a long bearer token is configured.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import signal
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

SOURCE_URL = "https://osiris-production-807f1d73.up.railway.app/api/news"
MAX_RESPONSE_BYTES = 5_000_000
MAX_HEADLINE_CHARS = 500
MAX_EVENTS_PER_FEED = 5000
LOG = logging.getLogger("osiris.collector")
UTC = timezone.utc


def utcnow() -> datetime:
    return datetime.now(UTC)


def parse_date(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Missing RFC3339 datetime")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("Timezone required")
    return dt.astimezone(UTC)


def validate_feed(document: object, now: datetime | None = None) -> dict:
    now = now or utcnow()
    if not isinstance(document, dict):
        raise ValueError("Expected JSON object")
    collected = parse_date(document.get("timestamp"))
    if not timedelta(minutes=-2) <= now - collected <= timedelta(minutes=20):
        raise ValueError("Untrustworthy feed timestamp")
    news, sources = document.get("news"), document.get("sources")
    if not isinstance(news, list) or len(news) > MAX_EVENTS_PER_FEED:
        raise ValueError("Invalid news collection")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 200:
        raise ValueError("Invalid source collection")
    if document.get("total") != len(news):
        raise ValueError("Inconsistent item count")
    healthy = 0
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("handle"), str):
            raise ValueError("Invalid source record")
        if source.get("state") in ("ok", "empty"):
            healthy += 1
    if not news and not healthy:
        raise ValueError("No stories and no healthy sources")
    for item in news:
        if not isinstance(item, dict):
            raise ValueError("Invalid event")
        for key in ("id", "title", "published", "link", "source"):
            if not isinstance(item.get(key), str) or not item[key]:
                raise ValueError("Missing required event field: " + key)
        if len(item["id"]) > 200 or len(item["title"]) > MAX_HEADLINE_CHARS:
            raise ValueError("Oversized event identity/title")
        published = parse_date(item["published"])
        if published > now + timedelta(minutes=5):
            raise ValueError("Event timestamp in the future")
        link = urlsplit(item["link"])
        if link.scheme not in ("http", "https") or not link.hostname:
            raise ValueError("Event link must be an HTTP URL")
    return document


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def fetch_feed() -> dict:
    # Fixed host; no redirects, user-controlled URL or credentials.
    request = Request(SOURCE_URL, headers={"Accept": "application/json", "User-Agent": "OSIRIS-History-Collector/0.1"})
    with build_opener(NoRedirect()).open(request, timeout=20) as response:
        content_type = response.headers.get("Content-Type", "").lower()
        if response.status != 200 or "json" not in content_type:
            raise ValueError("Source did not return JSON 200")
        declared_size = response.headers.get("Content-Length")
        if declared_size and int(declared_size) > MAX_RESPONSE_BYTES:
            raise ValueError("Oversized source response")
        payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise ValueError("Oversized source response")
    return validate_feed(json.loads(payload))


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=15000")
    db.execute("PRAGMA synchronous=NORMAL")
    return db


def setup(db: sqlite3.Connection) -> None:
    db.executescript("""
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      published_at TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_published_idx ON events(published_at DESC);
    CREATE INDEX IF NOT EXISTS events_source_idx ON events(source, published_at DESC);
    CREATE TABLE IF NOT EXISTS sources (
      handle TEXT PRIMARY KEY,
      name TEXT,
      state TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok','error')),
      received INTEGER NOT NULL DEFAULT 0,
      inserted INTEGER NOT NULL DEFAULT 0,
      error_kind TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_attempted_idx ON collection_runs(attempted_at DESC);
    """)


def ingest(db: sqlite3.Connection, document: dict, now: datetime | None = None,
           retention_days: int = 90) -> tuple[int, int]:
    now = now or utcnow()
    validate_feed(document, now)
    stamp = now.isoformat()
    inserted = 0
    with db:
        for item in document["news"]:
            published = parse_date(item["published"]).isoformat()
            raw = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
            cursor = db.execute("""INSERT OR IGNORE INTO events
              (id,published_at,source,title,url,first_seen_at,last_seen_at,payload_json)
              VALUES (?,?,?,?,?,?,?,?)""", (item["id"], published, item["source"],
              item["title"], item["link"], stamp, stamp, raw))
            inserted += cursor.rowcount
            if cursor.rowcount == 0:
                db.execute("UPDATE events SET last_seen_at=? WHERE id=?", (stamp, item["id"]))
        for source in document["sources"]:
            handle = source["handle"][:200]
            db.execute("""INSERT INTO sources(handle,name,state,item_count,observed_at)
              VALUES(?,?,?,?,?) ON CONFLICT(handle) DO UPDATE SET
              name=excluded.name,state=excluded.state,item_count=excluded.item_count,
              observed_at=excluded.observed_at""", (
                handle, str(source.get("name") or handle)[:200],
                str(source.get("state") or "unknown")[:50],
                int(source.get("count") or 0), stamp,
            ))
        db.execute("INSERT INTO collection_runs(attempted_at,status,received,inserted) VALUES(?,?,?,?)",
                   (stamp, "ok", len(document["news"]), inserted))
        cutoff = (now - timedelta(days=max(7, min(365, retention_days)))).isoformat()
        db.execute("DELETE FROM events WHERE published_at < ?", (cutoff,))
        db.execute("DELETE FROM collection_runs WHERE attempted_at < ?", (cutoff,))
    return len(document["news"]), inserted


def record_failure(db: sqlite3.Connection, error: Exception) -> None:
    # Store only the exception class, never URLs, credentials or raw responses.
    with db:
        db.execute("INSERT INTO collection_runs(attempted_at,status,error_kind) VALUES(?,?,?)",
                   (utcnow().isoformat(), "error", type(error).__name__))


def archive_status(db: sqlite3.Connection) -> dict:
    last_ok = db.execute("SELECT attempted_at FROM collection_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").fetchone()
    last_run = db.execute("SELECT attempted_at,status FROM collection_runs ORDER BY id DESC LIMIT 1").fetchone()
    return {
        "scope": "collector-and-local-archive",
        "events": db.execute("SELECT count(*) FROM events").fetchone()[0],
        "sources": db.execute("SELECT count(*) FROM sources").fetchone()[0],
        "last_success_at": last_ok[0] if last_ok else None,
        "last_run_at": last_run[0] if last_run else None,
        "last_run_status": last_run[1] if last_run else "never",
    }


def make_handler(db_path: str, api_token: str):
    class Handler(BaseHTTPRequestHandler):
        def _respond(self, code: int, payload: dict):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            route = urlsplit(self.path)
            if route.path not in ("/health", "/events", "/sources"):
                return self._respond(404, {"error": "not_found"})
            if route.path != "/health":
                if len(api_token) < 32:
                    return self._respond(503, {"error": "archive_api_disabled"})
                supplied = self.headers.get("Authorization", "")
                if not hmac.compare_digest(supplied, "Bearer " + api_token):
                    return self._respond(401, {"error": "unauthorized"})
            try:
                with connect(db_path) as db:
                    if route.path == "/health":
                        return self._respond(200, {"status": "serving", **archive_status(db)})
                    if route.path == "/sources":
                        sources = [dict(row) for row in db.execute("SELECT * FROM sources ORDER BY handle")]
                        return self._respond(200, {"sources": sources})
                    q = parse_qs(route.query)
                    try:
                        limit = min(100, max(1, int(q.get("limit", ["30"])[0])))
                    except (ValueError, OverflowError):
                        return self._respond(400, {"error": "invalid_limit"})
                    before = q.get("before", [None])[0]
                    if before is not None:
                        try:
                            before = parse_date(before).isoformat()
                        except (TypeError, ValueError):
                            return self._respond(400, {"error": "invalid_before"})
                    if before:
                        sql = "SELECT payload_json FROM events WHERE published_at < ? ORDER BY published_at DESC LIMIT ?"
                        rows = db.execute(sql, (before, limit)).fetchall()
                    else:
                        rows = db.execute("SELECT payload_json FROM events ORDER BY published_at DESC LIMIT ?", (limit,)).fetchall()
                    return self._respond(200, {"events": [json.loads(row[0]) for row in rows], "limit": limit})
            except sqlite3.Error:
                LOG.exception("Archive read failed")
                return self._respond(503, {"error": "archive_unavailable"})

        def log_message(self, fmt: str, *args):
            LOG.info("HTTP: " + fmt, *args)
    return Handler


def collect_loop(db_path: str, stop: threading.Event, poll_seconds: int,
                 retention_days: int):
    while not stop.is_set():
        try:
            document = fetch_feed()
            with connect(db_path) as db:
                seen, inserted = ingest(db, document, retention_days=retention_days)
            LOG.info("OSINT archive updated: seen=%d added=%d", seen, inserted)
        except Exception as exc:
            LOG.warning("OSINT archive refresh failed: %s", type(exc).__name__)
            try:
                with connect(db_path) as db:
                    record_failure(db, exc)
            except sqlite3.Error:
                LOG.exception("Cannot record collector failure")
        stop.wait(poll_seconds)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    os.umask(0o077)
    db_path = os.getenv("OSIRIS_COLLECTOR_DB_PATH", "/data/news.sqlite3")
    api_token = os.getenv("OSIRIS_COLLECTOR_API_TOKEN", "")
    poll_seconds = max(120, min(3600, int(os.getenv("OSIRIS_POLL_SECONDS", "300"))))
    retention_days = max(7, min(365, int(os.getenv("OSIRIS_RETENTION_DAYS", "90"))))
    port = int(os.getenv("PORT", "3000"))
    with connect(db_path) as db:
        setup(db)
    stop = threading.Event()
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(db_path, api_token))
    try:
        signal.signal(signal.SIGTERM, lambda *_: (stop.set(), threading.Thread(target=server.shutdown, daemon=True).start()))
        signal.signal(signal.SIGINT, lambda *_: (stop.set(), threading.Thread(target=server.shutdown, daemon=True).start()))
    except ValueError:
        pass
    worker = threading.Thread(target=collect_loop, args=(db_path, stop, poll_seconds, retention_days), daemon=True)
    worker.start()
    LOG.info("Collector listening on %d; events API %s", port, "enabled" if len(api_token) >= 32 else "disabled")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop.set()
        server.server_close()
        worker.join(timeout=5)


if __name__ == "__main__":
    main()
