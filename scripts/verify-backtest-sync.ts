import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase, getDb, insertSignal, setPortfolioConfig, upsertPriceRows, getPortfolioPositions } from '../electron/database';
import { syncPortfolio } from '../electron/portfolio';
import { getBacktestState } from '../electron/backtest';
import { sampleSignals } from '../src/lib/sampleData';

/** Exercise the production sync using only cached fixture prices: no network. */
async function verify(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-sync-'));
  try {
    initDatabase(path.join(dir, 'sync.db'));
    const date = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    setPortfolioConfig({ inceptionDate: date(0), maxHoldDays: 5 });
    insertSignal({ ...sampleSignals[0], ticker: 'TEST', scrapedAt: new Date().toISOString(), score: 80 });
    upsertPriceRows([{ ticker: 'SPY', date: date(1), adjClose: 500 }, { ticker: 'TEST', date: date(1), adjClose: 100 }]);
    assert.equal((await syncPortfolio()).ok, true);
    let state = getBacktestState();
    assert.equal(state.records.length, 2);
    assert(state.records.every(r => r.status === 'open' && r.snapshot.provenance === 'original'));
    const originals = new Map(state.records.map(r => [r.key, JSON.stringify(r.snapshot)]));
    // Expire all alert/outcome source rows while the positions are still open.
    getDb().exec('DELETE FROM signals; DELETE FROM signal_outcomes');
    upsertPriceRows([{ ticker: 'SPY', date: date(11), adjClose: 525 }, { ticker: 'TEST', date: date(11), adjClose: 110 }]);
    assert.equal((await syncPortfolio()).ok, true);
    state = getBacktestState();
    assert.equal(state.records.length, 2);
    assert(state.records.every(r => r.status === 'complete' && r.trades.length === 2));
    assert(state.records.every(r => originals.get(r.key) === JSON.stringify(r.snapshot)));
    assert.equal(getPortfolioPositions()[0].entryDate, date(1));
    assert.equal(getPortfolioPositions()[0].exitDate, date(11));
    const saved = state.records;
    assert.equal((await syncPortfolio()).ok, true);
    assert.deepEqual(getBacktestState().records, saved);
    closeDatabase(); initDatabase(path.join(dir, 'sync.db'));
    assert.deepEqual(getBacktestState().records, saved);
    console.log('Production portfolio sync: both depots buy with snapshots, retain entries after source expiry, close and analyze, repeat without duplicates, and survive restart. No network requests.');
  } finally { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); }
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
