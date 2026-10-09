from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('history', Path(__file__).resolve().parents[2] / 'scripts/history-snapshot.py')
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / 'history.db'
        self.remote = self.root / 'remote'
        self.remote.mkdir()
        self.exists = False
        self.upload_failure = False
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript('''
                CREATE TABLE signals(id INTEGER PRIMARY KEY, ticker TEXT, scraped_at TEXT);
                CREATE TABLE scrape_log(id INTEGER PRIMARY KEY, started_at TEXT);
                CREATE TABLE insider_trades(id INTEGER PRIMARY KEY, ticker TEXT, insider_key TEXT, trade_date TEXT, value_cents INTEGER);
                CREATE TABLE portfolio_equity(date TEXT PRIMARY KEY, value REAL);
                INSERT INTO signals VALUES(1, 'OLD', '2026-09-11');
                INSERT INTO portfolio_equity VALUES('2026-09-21', 12345);
            ''')
        self.addCleanup(patch.stopall)
        patch.object(history, 'gh', side_effect=self.gh).start()
        self.download = patch.object(history, 'download_asset', side_effect=lambda repo, asset, target: shutil.copyfile(self.remote / asset['name'], target)).start()
        patch.dict(os.environ, {'GITHUB_SHA': 'abc'}).start()

    def gh(self, *args):
        if args[0] == 'api':
            if '/releases/tags/' in args[-1]:
                if not self.exists:
                    raise subprocess.CalledProcessError(1, args, stderr='gh: Not Found (HTTP 404)')
                return json.dumps({'id': 1})
            return json.dumps([[{'id': i, 'name': p.name, 'state': 'uploaded', 'created_at': f'{i:09d}'}
                                for i, p in enumerate(sorted(self.remote.iterdir()), 1)]])
        if args[:2] == ('release', 'create'):
            self.exists = True
        elif args[:2] == ('release', 'upload'):
            if self.upload_failure:
                raise subprocess.CalledProcessError(1, args, stderr='upload failed')
            shutil.copyfile(args[3], self.remote / Path(args[3]).name)
        elif args[:2] == ('release', 'download'):
            name = args[args.index('--pattern') + 1]
            dest = Path(args[args.index('--dir') + 1])
            shutil.copyfile(self.remote / name, dest / name)
        else:
            raise AssertionError(args)
        return ''

    def save(self, run='100'):
        history.save('owner/repo', self.db, self.root / f'output-{run}', run, '1')

    def test_restore_downloads_selected_id_without_second_release_lookup(self):
        self.save()
        original = self.gh
        def stale_release(*args):
            if args[:2] == ('release', 'download'):
                raise AssertionError('Release name lookup must not run during restore')
            return original(*args)
        with patch.object(history, 'gh', side_effect=stale_release):
            history.restore('owner/repo', self.db)
        self.download.assert_called_once()
        self.assertEqual(self.download.call_args.args[1]['id'], 1)

    def test_large_database_roundtrip(self):
        # Larger than GitHub's raw Git blob limit, including an incompressible row.
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('CREATE TABLE payload(data BLOB)')
            db.execute('INSERT INTO payload VALUES(zeroblob(106000000))')
            db.execute('INSERT INTO payload VALUES(?)', (os.urandom(1024 * 1024),))
        self.assertGreater(self.db.stat().st_size, 100 * 1024 * 1024)
        db.close()
        with closing(sqlite3.connect(self.db)) as db:
            before = [(len(row[0]), hashlib.sha256(row[0]).hexdigest()) for row in db.execute('SELECT data FROM payload')]
        self.save()
        self.db.unlink()
        history.restore('owner/repo', self.db)
        with closing(sqlite3.connect(self.db)) as db:
            after = [(len(row[0]), hashlib.sha256(row[0]).hexdigest()) for row in db.execute('SELECT data FROM payload')]
        self.assertEqual(after, before)

    def test_failed_upload_preserves_previous_snapshot(self):
        self.save()
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO signals VALUES(2, 'NEW', '2026-09-22')")
        self.upload_failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.save('101')
        self.assertEqual(len(list(self.remote.iterdir())), 1)
        history.restore('owner/repo', self.db)
        with closing(sqlite3.connect(self.db)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM signals').fetchone()[0], 1)
        self.assertTrue(list((self.root / 'output-101').glob('*.gz')))

    def test_corrupt_snapshot_does_not_replace_local_database(self):
        self.save()
        before = history.digest(self.db)
        next(self.remote.iterdir()).write_bytes(b'corrupted download')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            history.restore('owner/repo', self.db)
        self.assertEqual(history.digest(self.db), before)

    def test_auth_error_and_empty_release_never_fall_back(self):
        with patch.object(history, 'gh', side_effect=subprocess.CalledProcessError(1, [], stderr='HTTP 403')):
            with self.assertRaises(subprocess.CalledProcessError):
                history.restore('owner/repo', self.db)
        self.exists = True
        with self.assertRaisesRegex(RuntimeError, 'no complete snapshot'):
            history.restore('owner/repo', self.db)

    def test_initial_bootstrap_keeps_committed_database(self):
        before = history.digest(self.db)
        history.restore('owner/repo', self.db)
        self.assertEqual(history.digest(self.db), before)

    def test_desktop_merge_preserves_cloud_state_and_is_idempotent(self):
        self.save()
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('DELETE FROM portfolio_equity')
            db.execute("INSERT INTO signals VALUES(2, 'DESKTOP', '2026-09-22')")
        history.restore('owner/repo', self.db, desktop=True)
        history.restore('owner/repo', self.db, desktop=True)
        with closing(sqlite3.connect(self.db)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM signals').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT value FROM portfolio_equity').fetchone()[0], 12345)

    def test_backtest_evidence_merge_preserves_originals_and_versions(self):
        incoming = self.root / 'backtest.db'
        shutil.copyfile(self.db, incoming)
        with closing(sqlite3.connect(incoming)) as db, db:
            db.executescript('''
                CREATE TABLE backtest_decisions(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE backtest_purchases(key TEXT PRIMARY KEY, portfolio TEXT NOT NULL, portfolio_id TEXT NOT NULL, strategy TEXT NOT NULL, snapshot TEXT NOT NULL);
                CREATE TABLE backtest_trades(key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE backtest_closures(key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE backtest_analyses(key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE backtest_replays(key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
                INSERT INTO backtest_decisions VALUES('alert', '{"score":80}');
                INSERT INTO backtest_purchases VALUES('buy', 'Hauptdepot', 'desktop:main', 'config', '{"original":true}');
                INSERT INTO backtest_trades VALUES('buy:buy', 'buy', '{"side":"buy"}');
                INSERT INTO backtest_closures VALUES('buy:close', 'buy', '{"pnl":10}');
                INSERT INTO backtest_analyses VALUES('version1', 'buy', '{"version":1}');
                INSERT INTO backtest_analyses VALUES('version2', 'buy', '{"version":2}');
            ''')
        history.merge_desktop(self.db, incoming)
        history.merge_desktop(self.db, incoming)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM backtest_purchases').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM backtest_analyses').fetchone()[0], 2)
            original = db.execute('SELECT snapshot FROM backtest_purchases').fetchone()[0]
        with closing(sqlite3.connect(incoming)) as db, db:
            db.execute("UPDATE backtest_purchases SET snapshot='changed'")
        history.merge_desktop(self.db, incoming)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT snapshot FROM backtest_purchases').fetchone()[0], original)
        self.save()
        self.db.unlink()
        history.restore('owner/repo', self.db)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT snapshot FROM backtest_purchases').fetchone()[0], original)
            self.assertEqual(db.execute('SELECT count(*) FROM backtest_analyses').fetchone()[0], 2)

    def test_chunked_desktop_merge_on_scheduled_run_and_corrupt_part_rejected(self):
        self.save()
        incoming = self.root / 'incoming.db'
        shutil.copyfile(self.db, incoming)
        with closing(sqlite3.connect(incoming)) as db, db:
            db.execute("INSERT INTO signals VALUES(2, 'DESKTOP', '2026-09-22')")
        db.close()
        import gzip
        payload = gzip.compress(incoming.read_bytes())
        package = self.root / 'desktop-publish'
        package.mkdir()
        parts = []
        for offset in range(0, len(payload), 100):
            block = payload[offset:offset + 100]
            name = f'part-{len(parts):06d}.gzpart'
            (package / name).write_bytes(block)
            parts.append({'name': name, 'bytes': len(block), 'sha256': hashlib.sha256(block).hexdigest()})
        (package / 'manifest.json').write_text(json.dumps({
            'version': 1, 'format': 'sqlite-gzip', 'parts': parts,
            'sha256': hashlib.sha256(payload).hexdigest(),
        }))
        history.restore('owner/repo', self.db)  # no desktop flag on a schedule
        with closing(sqlite3.connect(self.db)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM signals').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT value FROM portfolio_equity').fetchone()[0], 12345)
        db.close()
        before = history.digest(self.db)
        (package / parts[0]['name']).write_bytes(b'x' * parts[0]['bytes'])
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            history.restore('owner/repo', self.db)
        self.assertEqual(history.digest(self.db), before)

    def test_sqlite_backup_includes_live_wal(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute("INSERT INTO signals VALUES(2, 'WAL', '2026-09-22')")
            db.commit()
            self.save()
        # sqlite3's context manager commits but does not close.
        db.close()
        history.restore('owner/repo', self.db)
        with closing(sqlite3.connect(self.db)) as restored, restored:
            self.assertEqual(restored.execute('SELECT count(*) FROM signals').fetchone()[0], 2)


class AssetDownloadTests(unittest.TestCase):
    def test_retries_exact_asset_id_and_discards_partial_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'snapshot.gz'
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                kwargs['stdout'].write(b'partial' if len(calls) == 1 else b'complete')
                return subprocess.CompletedProcess(args, 1 if len(calls) == 1 else 0, stderr=b'HTTP 503')
            with patch.object(history.subprocess, 'run', side_effect=run), patch.object(history.time, 'sleep'):
                history.download_asset('owner/repo', {'id': 123}, target)
            self.assertEqual(target.read_bytes(), b'complete')
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(c[-1] == 'repos/owner/repo/releases/assets/123' for c in calls))

    def test_exhausted_download_reports_error_and_removes_partial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'snapshot.gz'
            result = subprocess.CompletedProcess([], 1, stderr=b'HTTP 403')
            with patch.object(history.subprocess, 'run', return_value=result), patch.object(history.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'HTTP 403'):
                    history.download_asset('owner/repo', {'id': 123}, target)
            self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
