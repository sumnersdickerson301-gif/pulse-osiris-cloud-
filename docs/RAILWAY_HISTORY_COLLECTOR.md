# OSIRIS — durable OSINT history collector (prepared, NOT deployed)

## Goal

The current Railway OSIRIS Next.js service returns /api/news successfully.
The history collector is a separate small Python 3.12 process, packaged at
services/news-collector. It downloads the fixed HTTPS Railway /api/news endpoint
once every five minutes, validates freshness and structure, deduplicates by
stable event ID and writes the full public event record to persistent SQLite.

This is **not** a claim of fully reliable 24/7 ingestion. Until a new Railway
service with a persistent volume is deployed, no production history exists.

## Current verified Railway evidence (28 November 2026)

- Existing Railway service osiris: 1 running replica, /api/news returns HTTP 200.
- Browser inspection: JSON response contained 117 items, 18 sources, all
  reported state ok. This is a snapshot, not a guarantee each story is true.
- No persistent volumes, managed databases or dedicated worker were configured.
- Railway's existing environment already has an unrelated STAGED martin
  service. **Do not accept/deploy this patch just to start the collector.**

## Testing

Run at repository root:

    cd services/news-collector
    python -m unittest -v
    python -m py_compile collector.py

Requires only the Python 3.12 standard library. No API keys needed for tests.

## Proposed Railway deployment (requires review/approval)

1. Create an **independent Railway environment** for testing when available,
   otherwise create a separate dedicated test project. Do not attach to the
   existing production environment patch that contains Martin.
2. Add a new GitHub-based service with root directory
   services/news-collector. Railway should build Dockerfile in this directory.
3. Attach a **persistent Railway volume at /data** and keep **one replica**.
   The Alpine entrypoint grants access to the mounted directory and then
   drops root to the collector user.
4. Configure environment variables (no secrets in GitHub):

   OSIRIS_COLLECTOR_DB_PATH=/data/news.sqlite3
   OSIRIS_POLL_SECONDS=300
   OSIRIS_RETENTION_DAYS=90
   PORT=3000
   OSIRIS_COLLECTOR_API_TOKEN=<unique random secret of 32+ characters>

5. Initially do **not** attach a public service domain. Inspect /health,
   ingestion logs, and database file/volume persistence across a restart.
6. Access /events and /sources only with Authorization: Bearer <secret>.
   If this API must be exposed to Vercel, use a separate HTTPS domain, long
   rotated token stored as a sensitive Vercel environment variable, a
   scoped read-only route and rate limits. Never give the token to the browser.
7. Review volume costs, quotas, retention, snapshot backups and restoration.
   SQLite/WAL is designed for one writer in one replica. For high availability
   or geographically distributed writers, migrate to managed Postgres.

## Data model

- events — unique ID, published time, source, title, URL, full JSON payload,
  first seen and most recently seen timestamps; indices for time and source.
- sources — latest observed source state and item count.
- collection_runs — successful/failed collection attempts and counts;
  error class only, not raw responses or secrets.

The loop checks freshness before writes. Failures never overwrite existing
events, and duplicates cannot create multiple event rows. Events older than
OSIRIS_RETENTION_DAYS (7–365, default 90) are deleted on a successful cycle.
The source /api/news itself covers a limited recent window; the archive can
only retain events from the point the worker actually starts running.

## API

- GET /health — process/storage status and counts. It does **not** guarantee
  that the latest upstream request succeeded; inspect last_run_status and
  last_success_at.
- GET /events?limit=30&before=RFC3339 — newest first, max 100; Bearer required.
- GET /sources — current observed source state; Bearer required.

If OSIRIS_COLLECTOR_API_TOKEN is unset or shorter than 32 characters, /events
and /sources return 503. Wrong token returns 401. Unknown paths return 404.
CORS headers are not set, so browser cross-origin access is not supported.

## Existing Vercel Preview pilot

Vercel preview branch fix/openfreemap has OSIRIS_NEWS_BACKEND=railway and its
/api/news route tries Railway with a validated local fallback. This pilot is
independent of the durable archive. The current Production release is
unaffected, and no collector worker has been deployed to Railway yet.

A server-side proxy has been **prepared but remains disabled** at
GET /api/history. To enable it ONLY after the worker is deployed and tested,
configure these as sensitive Vercel environment variables for a Preview branch:

    OSIRIS_HISTORY_API_URL=https://<collector-domain>.up.railway.app/
    OSIRIS_HISTORY_API_TOKEN=<same strong secret as the worker>

The proxy pins the HTTPS destination to Railway, never exposes the token,
validates response shape, and returns 502 on worker failures. Do not set the
variables in Production until real-data authentication, pagination, volume
persistence and fallback have been verified. The UI does not consume this
archive yet.
