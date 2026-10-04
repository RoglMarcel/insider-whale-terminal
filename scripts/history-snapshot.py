#!/usr/bin/env python3
"""Durable cloud history snapshots; requires gh and GH_TOKEN on the runner.

Immutable, checksummed release assets avoid Git's 100 MB limit. A failed upload
never replaces the last good snapshot. Only an explicit 404 permits bootstrap.
"""
import argparse
from contextlib import closing
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time

TAG = 'history-data'
ASSET = re.compile(r'^history-\d+-\d+-([0-9a-f]{64})\.db\.gz$')
DESKTOP_TABLES = {
    'signals': ['ticker', 'scraped_at'],
    'scrape_log': ['started_at'],
    'insider_trades': ['ticker', 'insider_key', 'trade_date', 'value_cents'],
}


def gh(*args):
    return subprocess.run(['gh', *args], check=True, text=True, capture_output=True).stdout


def release(repo):
    try:
        return json.loads(gh('api', f'repos/{repo}/releases/tags/{TAG}'))
    except subprocess.CalledProcessError as exc:
        if '(HTTP 404)' in exc.stderr:
            return None
        raise


def assets(repo, release_id):
    pages = json.loads(gh('api', '--paginate', '--slurp',
                         f'repos/{repo}/releases/{release_id}/assets?per_page=100'))
    return [a for page in pages for a in page
            if a['state'] == 'uploaded' and ASSET.fullmatch(a['name'])]


def download_asset(repo, asset, target):
    """Use the selected immutable ID, avoiding a second cached release lookup."""
    for attempt in range(3):
        try:
            with open(target, 'wb') as dest:
                result = subprocess.run(
                    ['gh', 'api', '-H', 'Accept: application/octet-stream',
                     f'repos/{repo}/releases/assets/{asset["id"]}'],
                    stdout=dest, stderr=subprocess.PIPE, timeout=180,
                )
            if result.returncode == 0:
                return
            error = result.stderr.decode('utf-8', errors='replace').strip()
        except subprocess.TimeoutExpired:
            error = 'download timed out'
        target.unlink(missing_ok=True)
        if attempt < 2:
            time.sleep(2 ** attempt)
    raise RuntimeError(f'History asset {asset["id"]} download failed: {error}')


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def check_db(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        result = db.execute('PRAGMA quick_check').fetchall()
        if result != [('ok',)]:
            raise RuntimeError(f'SQLite integrity check failed: {result}')
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table'").fetchone():
            raise RuntimeError('Refusing an empty database')


def unpack(archive, target, expected):
    if digest(archive) != expected:
        raise RuntimeError('Snapshot checksum mismatch')
    with gzip.open(archive, 'rb') as source, open(target, 'wb') as dest:
        shutil.copyfileobj(source, dest)
    check_db(target)


def merge_desktop(target, incoming):
    """Same identities as electron/webPublish.ts; preserve cloud-only tables."""
    with closing(sqlite3.connect(target)) as db:
        db.execute('ATTACH DATABASE ? AS desktop', (str(incoming.resolve()),))
        for table, identity in DESKTOP_TABLES.items():
            columns = [r[1] for r in db.execute(f'PRAGMA main.table_info("{table}")')]
            source = [r[1] for r in db.execute(f'PRAGMA desktop.table_info("{table}")')]
            cols = [c for c in columns if c != 'id' and c in source]
            if not all(c in cols for c in identity):
                raise RuntimeError(f'Cannot safely merge desktop table {table}')
            names = ', '.join('"' + c.replace('"', '""') + '"' for c in cols)
            values = ', '.join('s."' + c.replace('"', '""') + '"' for c in cols)
            match = ' AND '.join(f't."{c}" IS s."{c}"' for c in identity)
            db.execute(f'INSERT INTO main."{table}" ({names}) '
                       f'SELECT {values} FROM desktop."{table}" s WHERE NOT EXISTS '
                       f'(SELECT 1 FROM main."{table}" t WHERE {match})')
        db.commit()


def unpack_desktop(directory, target):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('version') != 1 or manifest.get('format') != 'sqlite-gzip':
        raise RuntimeError('Unsupported desktop snapshot format')
    parts = manifest.get('parts')
    if not isinstance(parts, list) or not parts:
        raise RuntimeError('Desktop snapshot has no parts')
    archive = target.with_suffix('.gz')
    with open(archive, 'wb') as out:
        for index, part in enumerate(parts):
            name = f'part-{index:06d}.gzpart'
            if part.get('name') != name:
                raise RuntimeError('Invalid desktop part order or path')
            source = directory / name
            size = source.stat().st_size
            if source.is_symlink() or size != part.get('bytes') or not 0 < size <= 32 * 1024 * 1024:
                raise RuntimeError('Invalid desktop part size or link')
            if digest(source) != part.get('sha256'):
                raise RuntimeError('Desktop part checksum mismatch')
            with open(source, 'rb') as stream:
                shutil.copyfileobj(stream, out)
    unpack(archive, target, manifest.get('sha256'))


def restore(repo, path, desktop=False):
    rel = release(repo)
    package = path.parent / 'desktop-publish'
    has_package = (package / 'manifest.json').is_file()
    if rel is None and not has_package:
        check_db(path)
        print('No history release yet: bootstrapping from the committed database.')
        return
    candidates = assets(repo, rel['id']) if rel else []
    if rel and not candidates:
        raise RuntimeError('History release exists but has no complete snapshot; refusing stale fallback')
    with tempfile.TemporaryDirectory(dir=path.parent) as directory:
        tmp = Path(directory)
        restored = tmp / 'restored.db'
        if rel:
            latest = max(candidates, key=lambda a: (a['created_at'], a['id']))
            download_asset(repo, latest, tmp / latest['name'])
            unpack(tmp / latest['name'], restored, ASSET.fullmatch(latest['name'])[1])
            print(f'Restored {latest["name"]}')
        else:
            check_db(path)
            shutil.copyfile(path, restored)
        # Also ingest on scheduled runs: a skipped/coalesced desktop push must
        # not lose rows. Natural-key merging is idempotent.
        if has_package:
            incoming = tmp / 'desktop.db'
            unpack_desktop(package, incoming)
            merge_desktop(restored, incoming)
            print('Verified and merged desktop snapshot')
        elif desktop:
            check_db(path)
            merge_desktop(restored, path)  # compatibility with old desktop builds
        check_db(restored)
        if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm')):
            raise RuntimeError('Refusing to replace a database with active SQLite sidecars')
        os.replace(restored, path)


def save(repo, path, output, run_id, attempt):
    if not re.fullmatch(r'\d+', run_id) or not re.fullmatch(r'\d+', attempt):
        raise ValueError('Run ID and attempt must be numeric')
    output.mkdir(parents=True, exist_ok=True)
    # SQLite backup includes committed WAL content and yields a consistent file.
    with tempfile.TemporaryDirectory() as directory:
        snapshot = Path(directory) / 'snapshot.db'
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(snapshot)) as dest:
                source.backup(dest)
                dest.execute('PRAGMA journal_mode=DELETE')
        check_db(snapshot)
        archive = output / 'snapshot.db.gz'
        with open(snapshot, 'rb') as source, open(archive, 'wb') as dest:
            with gzip.GzipFile(filename='', mode='wb', fileobj=dest, mtime=0) as compressed:
                shutil.copyfileobj(source, compressed)
    name = f'history-{run_id}-{attempt}-{digest(archive)}.db.gz'
    archive = archive.rename(output / name)
    rel = release(repo)
    if rel is None:
        gh('release', 'create', TAG, '--repo', repo, '--target', os.environ['GITHUB_SHA'],
           '--prerelease', '--latest=false', '--title', 'Cloud history snapshots',
           '--notes', 'Operational SQLite backups, not an application release. See docs/history-persistence.md.')
        rel = release(repo)
    existing = assets(repo, rel['id'])
    if not any(a['name'] == name for a in existing):
        gh('release', 'upload', TAG, str(archive), '--repo', repo)
    # Read back the actual bytes before acknowledging durability.
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        gh('release', 'download', TAG, '--repo', repo, '--pattern', name, '--dir', str(tmp))
        unpack(tmp / name, tmp / 'verified.db', ASSET.fullmatch(name)[1])
    print(f'Persisted and verified {name}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['restore', 'save'])
    parser.add_argument('--database', type=Path, default=Path('data/insider-tracker.db'))
    parser.add_argument('--desktop', action='store_true')
    parser.add_argument('--output', type=Path, default=Path('tmp/history-backup'))
    args = parser.parse_args()
    repo = os.environ['GITHUB_REPOSITORY']
    if args.operation == 'restore':
        restore(repo, args.database, args.desktop)
    else:
        save(repo, args.database, args.output, os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
