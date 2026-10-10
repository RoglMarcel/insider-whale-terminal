import { publishHistoryInBackground } from '../electron/historyBackground';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA, runMigrations, initDatabase, closeDatabase, getDb } from '../electron/database';
import { exportSharedHistory, mergeSharedHistory } from '../electron/sharedHistory';
import { packageDesktopSnapshot } from '../electron/desktopSnapshot';
import { syncFromWeb } from '../electron/webSync';
import { emptyPortfolioState } from '../src/lib/portfolio-rules';

async function verify(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-history-test-'));
  const originalFetch = globalThis.fetch;
  let cloud: Database.Database | undefined;
  try {
    const cloudPath = path.join(directory, 'cloud.db');
    cloud = new Database(cloudPath);
    cloud.exec(SCHEMA); runMigrations(cloud);
    cloud.prepare('INSERT INTO signals(ticker,score,scraped_at) VALUES(?,?,?)').run('WEB', 80, '2026-10-10T12:00:00Z');
    cloud.prepare('INSERT INTO signals(ticker,score,scraped_at) VALUES(?,?,?)').run('WEB', 80, '2026-10-10T12:00:00Z'); // legacy duplicate
    cloud.prepare('INSERT INTO scrape_log(started_at,status) VALUES(?,?)').run('2026-10-10T12:00:00Z', 'success');
    cloud.prepare('INSERT INTO price_history VALUES(?,?,?,?)').run('WEB', '2026-10-09', 110, '2026-10-10T12:00:00Z');
    cloud.prepare('INSERT INTO portfolio_equity VALUES(?,?,?,?,?,?,?,?)').run('2026-10-09', 100, 100, 1000, 1100, 1100, 1050, 1);
    cloud.prepare('INSERT INTO backtest_decisions VALUES(?,?)').run('cloud-decision', '{"evidence":"original"}');
    cloud.prepare('INSERT INTO app_settings VALUES(?,?)').run('config', '{"private":"do not share"}');
    cloud.prepare('INSERT INTO app_settings VALUES(?,?)').run('portfolio_config', '{"initialCash":1000}');
    const exported = path.join(directory, 'public.db');
    const publishedView = emptyPortfolioState('Exact published portfolio view');
    exportSharedHistory(cloudPath, exported, publishedView);
    const transport = new Database(exported, { readonly: true });
    assert.equal(transport.prepare("SELECT 1 FROM app_settings WHERE key='config'").get(), undefined);
    transport.close();

    initDatabase(path.join(directory, 'desktop.db'));
    const desktop = getDb();
    desktop.prepare('INSERT INTO signals(ticker,score,scraped_at) VALUES(?,?,?)').run('LOCAL', 85, '2026-10-09T12:00:00Z');
    desktop.prepare('INSERT INTO price_history VALUES(?,?,?,?)').run('WEB', '2026-10-09', 100, '2026-10-09T12:00:00Z');
    desktop.prepare('INSERT INTO portfolio_equity VALUES(?,?,?,?,?,?,?,?)').run('2026-10-08', 10, 10, 10, 20, 20, 20, 1);
    desktop.prepare('INSERT INTO app_settings VALUES(?,?)').run('config', '{"private":"local"}');
    const revision = '2026-10-10T12:05:00.000Z';
    mergeSharedHistory(desktop, exported, revision);
    mergeSharedHistory(desktop, exported, revision);
    assert.equal((desktop.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n, 2);
    assert.equal((desktop.prepare('SELECT COUNT(*) AS n FROM scrape_log').get() as { n: number }).n, 1);
    assert.equal((desktop.prepare('SELECT adj_close AS price FROM price_history').get() as { price: number }).price, 110);
    assert.deepEqual(desktop.prepare('SELECT date,equity FROM portfolio_equity').all(), [{ date: '2026-10-09', equity: 1100 }]);
    assert.equal((desktop.prepare("SELECT value FROM app_settings WHERE key='config'").get() as { value: string }).value, '{"private":"local"}');
    assert.equal((desktop.prepare('SELECT COUNT(*) AS n FROM portfolio_revisions').get() as { n: number }).n, 1);
    assert.deepEqual(JSON.parse((desktop.prepare("SELECT value FROM app_settings WHERE key='shared_portfolio_state'").get() as { value: string }).value), publishedView);
    // Upload the merged desktop evidence back into the cloud without replacing
    // its simulated book. Each direction must be repeatable independently.
    const outgoing = path.join(directory, 'outgoing.db');
    exportSharedHistory(desktop.name, outgoing);
    mergeSharedHistory(cloud, outgoing);
    mergeSharedHistory(cloud, outgoing);
    assert.equal((cloud.prepare('SELECT COUNT(DISTINCT ticker) AS n FROM signals').get() as { n: number }).n, 2);
    assert.deepEqual(cloud.prepare('SELECT date,equity FROM portfolio_equity').all(), [{ date: '2026-10-09', equity: 1100 }]);
    // Old remote prices and books cannot move the local state backwards.
    cloud.prepare('UPDATE price_history SET adj_close=90,fetched_at=?').run('2026-10-08T12:00:00Z');
    mergeSharedHistory(desktop, cloudPath, '2026-10-09T12:00:00.000Z');
    assert.equal((desktop.prepare('SELECT adj_close AS price FROM price_history').get() as { price: number }).price, 110);

    // A broken book rolls back even evidence inserted earlier in the transaction.
    cloud.prepare('INSERT INTO signals(ticker,score,scraped_at) VALUES(?,?,?)').run('ROLLBACK', 90, revision);
    cloud.exec('DROP TABLE portfolio_events');
    assert.throws(() => mergeSharedHistory(desktop, cloudPath, '2026-10-10T13:00:00.000Z'), /Missing shared book/);
    assert.equal(desktop.prepare("SELECT 1 FROM signals WHERE ticker='ROLLBACK'").get(), undefined);

    const packageDir = path.join(directory, 'package');
    await packageDesktopSnapshot(exported, packageDir, 4096);
    const manifest = { ...JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8')), generatedAt: '2026-10-10T14:00:00.000Z' };
    let corrupt = true;
    let calls = 0;
    globalThis.fetch = async (input) => {
      calls++;
      if (String(input).endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
      const name = String(input).split('/').at(-1)!;
      const bytes = fs.readFileSync(path.join(packageDir, name));
      if (corrupt) bytes[0] ^= 1;
      return new Response(bytes);
    };
    assert.equal((await syncFromWeb()).ok, false);
    assert.equal((desktop.prepare("SELECT value FROM app_settings WHERE key='web_sync_revision'").get() as { value: string }).value, revision);
    corrupt = false;
    let responsiveTicks = 0;
    const heartbeat = setInterval(() => responsiveTicks++, 1);
    const first = syncFromWeb(); const second = syncFromWeb();
    assert.equal(first, second, 'concurrent requests must coalesce');
    try { assert.equal((await first).ok, true); } finally { clearInterval(heartbeat); }
    assert.ok(responsiveTicks > 0, 'history import must leave the event loop responsive');
    const before = calls;
    assert.equal((await syncFromWeb()).changed, false);
    assert.equal(calls - before, 1, 'unchanged revision only fetches manifest');
    assert.equal((desktop.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n, 2);
    const fixtureRepo = path.join(directory, 'local-export');
    fs.mkdirSync(path.join(fixtureRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, 'package.json'), '{}');
    const publication = publishHistoryInBackground({ repoPath: fixtureRepo, push: false });
    assert.equal(publication, publishHistoryInBackground({ repoPath: fixtureRepo, push: false }), 'background publications coalesce');
    const exportedResult = await publication;
    assert.equal(exportedResult.ok, true, exportedResult.error);
    assert.equal(exportedResult.pushed, false, 'worker fixture never pushes externally');
    assert.equal(exportedResult.copied?.signals, 2);
    console.log('Shared history verified: bidirectional evidence, no duplicates, private settings excluded, canonical book archived, newer prices, stale revisions, atomic rollback, corrupt download rejection and concurrent imports.');
  } finally {
    globalThis.fetch = originalFetch; cloud?.close(); closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
