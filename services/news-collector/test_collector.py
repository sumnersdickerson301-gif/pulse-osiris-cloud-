import json
import threading
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import collector

NOW = datetime(2026, 11, 28, 0, 0, tzinfo=timezone.utc)


def example_feed():
    return {
        'timestamp': (NOW - timedelta(minutes=1)).isoformat(),
        'news': [
            {'id': 'a', 'title': 'T1', 'published': (NOW - timedelta(minutes=5)).isoformat(), 'link': 'https://news.example/a', 'source': 'feed', 'summary': 's'},
            {'id': 'b', 'title': 'T2', 'published': (NOW - timedelta(minutes=2)).isoformat(), 'link': 'https://news.example/b', 'source': 'feed'},
        ],
        'total': 2,
        'sources': [{'handle': 'feed', 'name': 'Sample', 'state': 'ok', 'count': 2}],
    }


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / 'archive.sqlite3')
        self.db = collector.connect(self.db_path)
        collector.setup(self.db)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_ingest_and_dedupe(self):
        feed = example_feed()
        self.assertEqual(collector.ingest(self.db, feed, now=NOW), (2, 2))
        self.assertEqual(collector.ingest(self.db, feed, now=NOW + timedelta(minutes=1)), (2, 0))
        status = collector.archive_status(self.db)
        self.assertEqual(status['events'], 2)
        self.assertEqual(status['sources'], 1)
        self.assertEqual(status['last_run_status'], 'ok')

    def test_stale_and_fake_future_rejected(self):
        feed = example_feed()
        feed['timestamp'] = (NOW - timedelta(hours=5)).isoformat()
        with self.assertRaises(ValueError):
            collector.validate_feed(feed, NOW)
        feed = example_feed()
        feed['news'][0]['published'] = (NOW + timedelta(days=1)).isoformat()
        with self.assertRaises(ValueError):
            collector.validate_feed(feed, NOW)

    def test_failed_all_sources_no_empty_success(self):
        feed = example_feed()
        feed['news'] = []
        feed['sources'][0]['state'] = 'blocked'
        feed['total'] = 0
        with self.assertRaises(ValueError):
            collector.validate_feed(feed, NOW)

    def test_retention(self):
        feed = example_feed()
        feed['news'][0]['published'] = (NOW - timedelta(days=100)).isoformat()
        collector.ingest(self.db, feed, now=NOW, retention_days=90)
        self.assertEqual(collector.archive_status(self.db)['events'], 1)

    def test_failed_refresh_does_not_delete_archive(self):
        collector.ingest(self.db, example_feed(), now=NOW)
        collector.record_failure(self.db, ConnectionError('example-secret-never-store'))
        self.assertEqual(collector.archive_status(self.db)['events'], 2)
        error = self.db.execute("SELECT error_kind FROM collection_runs WHERE status='error'").fetchone()[0]
        self.assertEqual(error, 'ConnectionError')

    def test_archive_auth_disabled_by_default(self):
        handler = collector.make_handler(self.db_path, '')
        self.assertEqual(handler.__name__, 'Handler')

    def test_archive_http_requires_bearer_and_returns_history(self):
        collector.ingest(self.db, example_feed(), now=NOW)
        token = 's' * 48
        server = ThreadingHTTPServer(('127.0.0.1', 0), collector.make_handler(self.db_path, token))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}/events?limit=1'
        try:
            with self.assertRaises(HTTPError) as error:
                urlopen(url, timeout=2)
            self.assertEqual(error.exception.code, 401)
            with urlopen(Request(url, headers={'Authorization': 'Bearer ' + token}), timeout=2) as response:
                body = json.load(response)
            self.assertEqual(body['events'][0]['id'], 'b')
            self.assertEqual(len(body['events']), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_get_events_sorted(self):
        collector.ingest(self.db, example_feed(), now=NOW)
        items = [json.loads(row[0]) for row in self.db.execute('SELECT payload_json FROM events ORDER BY published_at DESC')]
        self.assertEqual([i['id'] for i in items], ['b', 'a'])


if __name__ == '__main__':
    unittest.main()
