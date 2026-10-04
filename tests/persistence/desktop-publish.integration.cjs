// Real SQLite -> bounded Git package -> Python decoder. No external writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { publishToWeb } = require('../../tmp/web-publish-test.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-delivery-'));
const repo = path.join(root, 'checkout');
const remote = path.join(root, 'remote.git');
const source = path.join(root, 'source.db');
const python = process.env.PYTHON || 'python3';
const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
(async () => {
  fs.mkdirSync(repo);
  run(['init', '--bare', remote], root);
  run(['init', '-b', 'main']);
  run(['config', 'user.name', 'Persistence Test']);
  run(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'original');
  run(['add', '.']); run(['commit', '-m', 'fixture']);
  run(['remote', 'add', 'origin', remote]); run(['push', '-u', 'origin', 'main']);
  // Diverged local history + dirty/staged source copies must not block delivery.
  fs.writeFileSync(path.join(repo, 'local-only.txt'), 'keep local');
  run(['add', '.']); run(['commit', '-m', 'local divergence']);
  const originalHead = run(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'staged user work');
  run(['add', 'unrelated.txt']);
  execFileSync(python, ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("""
CREATE TABLE signals(id INTEGER PRIMARY KEY,ticker TEXT,score REAL,scraped_at TEXT);
INSERT INTO signals VALUES(1,'TEST',80,'2026-09-22T10:00:00Z');
CREATE TABLE scrape_log(id INTEGER PRIMARY KEY,started_at TEXT);
CREATE TABLE insider_trades(id INTEGER PRIMARY KEY,ticker TEXT,insider_key TEXT,trade_date TEXT,value_cents INTEGER);
CREATE TABLE private_payload(data BLOB);
INSERT INTO private_payload VALUES(zeroblob(106000000));
""")
c.commit();c.close()`, source]);
  assert(fs.statSync(source).size > 100 * 1024 * 1024);
  const result = await publishToWeb({ repoPath: repo, sourceDbPathForTest: source, sinceIso: '2026-01-01' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.pushed, true);
  assert.equal(result.copied.signals, 1);
  const files = run(['diff-tree', '--no-commit-id', '--name-only', '-r', 'main'], remote).trim().split('\n');
  assert(files.every(p => p.startsWith('data/desktop-publish/')));
  assert.equal(run(['show', 'HEAD:unrelated.txt']), 'original');
  assert.equal(run(['diff', '--cached', '--name-only']).trim(), 'unrelated.txt');
  assert.equal(run(['rev-parse', 'HEAD']), originalHead);
  assert.equal(fs.readFileSync(path.join(repo, 'local-only.txt'), 'utf8'), 'keep local');
  const delivered = path.join(root, 'delivered');
  run(['clone', '--branch', 'main', remote, delivered], root);
  const decoder = path.resolve('scripts/history-snapshot.py');
  execFileSync(python, ['-c', `import importlib.util,sys,pathlib,sqlite3
spec=importlib.util.spec_from_file_location('h',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
p=pathlib.Path(sys.argv[3]);h.unpack_desktop(pathlib.Path(sys.argv[2]),p)
c=sqlite3.connect(p)
assert c.execute('select ticker from signals').fetchall()==[('TEST',)]
assert not c.execute("select 1 from sqlite_master where name='private_payload'").fetchone()
c.close()`, decoder, path.join(delivered, 'data/desktop-publish'), path.join(root, 'decoded.db')]);
  const before = run(['rev-parse', 'main'], remote);
  const again = await publishToWeb({ repoPath: repo, sourceDbPathForTest: source, sinceIso: '2026-01-01' });
  assert.equal(again.ok, true, again.error);
  assert.equal(run(['rev-parse', 'main'], remote), before, 'unchanged data must not trigger another deployment');
  console.log('Desktop delivery passed: >100 MB source, chunk-only Git commit, private data excluded, unrelated staged work preserved, Python restore verified.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
