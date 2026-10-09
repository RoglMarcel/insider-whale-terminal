import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase, getDb, insertSignal, replacePortfolioPositions, getPortfolioPositions, clearPortfolio } from '../electron/database';
import { getBacktestState, recordBacktestBook, recordBacktestClosures, analyzePendingBacktests, retryBacktest } from '../electron/backtest';
import { DEFAULT_PORTFOLIO_CONFIG, DEFAULT_SCORING_CONFIG, type PortfolioPosition } from '../src/types';
import { sampleSignals } from '../src/lib/sampleData';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-verify-'));
const file = path.join(dir, 'test.db');
try {
  initDatabase(file);
  const signal = { ...sampleSignals[0], ticker: 'TEST', scrapedAt: new Date().toISOString(), score: 80 };
  const context = { scoringAt: signal.scrapedAt, aggregate: { ticker: 'TEST', trades: signal.rawTrades, options: signal.optionsActivity, sourceUrls: signal.sourceUrls, vix: 22, marketCap: 1000000000, bestAccuracy3m: .7 }, scoringConfig: { ...DEFAULT_SCORING_CONFIG }, shadowConfig: null };
  const signalId = insertSignal(signal, context);
  const date = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const p: PortfolioPosition = { id: 1, ticker: 'TEST', signalId, entryDate: date(1), entryPrice: 100, shares: 10,
    costBasis: 1000, entryScore: 80, targetWeight: .1, highWaterClose: 100, exitDate: null, exitPrice: null,
    exitReason: null, realizedPnl: null, spyEntry: 500, spyExit: null };
  const config = { ...DEFAULT_PORTFOLIO_CONFIG };
  const commit = (positions: PortfolioPosition[]) => getDb().transaction(() => {
    replacePortfolioPositions(positions);
    recordBacktestBook('Hauptdepot', config, positions);
    recordBacktestClosures('Hauptdepot', config, positions);
  })();
  commit([p]);
  let state = getBacktestState();
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].snapshot.provenance, 'original');
  assert.equal(state.records[0].status, 'open');
  assert.deepEqual(state.records[0].snapshot.decision?.signal.rawTrades, signal.rawTrades);
  assert.deepEqual(state.records[0].snapshot.decision?.signal.breakdown, signal.breakdown);
  assert(state.records[0].snapshot.decision?.parameters.DEFAULT_SCORING_CONFIG);
  assert.deepEqual(state.records[0].snapshot.decision?.context, context);
  const original = JSON.stringify(state.records[0].snapshot);
  // Mutate source and config, then replay: the original decision remains intact.
  getDb().prepare('UPDATE signals SET score=99, score_breakdown=? WHERE id=?').run('{}', signalId);
  signal.breakdown.notes.push('mutation after purchase');
  commit([p]); commit([p]);
  assert.equal(JSON.stringify(getBacktestState().records[0].snapshot), original);
  assert.equal(getBacktestState().records[0].trades.length, 1);
  for (const table of ['backtest_purchases', 'backtest_decisions', 'backtest_trades']) {
    assert.throws(() => getDb().exec(`UPDATE ${table} SET key='changed'`), /immutable/);
    assert.throws(() => getDb().exec(`DELETE FROM ${table}`), /immutable/);
  }
  // Rollback proves purchase and archive cannot be committed separately.
  const second = { ...p, id: 2, entryDate: date(2) };
  assert.throws(() => getDb().transaction(() => { replacePortfolioPositions([second]); recordBacktestBook('Hauptdepot', config, [second]); throw new Error('interrupted commit'); })(), /interrupted/);
  assert.equal(getPortfolioPositions()[0].entryDate, p.entryDate);
  assert.equal(getBacktestState().records.length, 1);
  const closed = { ...p, exitDate: date(11), exitPrice: 110, exitReason: 'time' as const, realizedPnl: 100, spyExit: 525 };
  commit([closed]); analyzePendingBacktests();
  state = getBacktestState();
  const key = state.records[0].key;
  assert.equal(state.records[0].status, 'complete');
  assert.equal(state.records[0].analyses[0].result?.pnlUsd, 100);
  assert.equal(state.records[0].analyses[0].result?.holdDays, 10);
  assert.equal(state.records[0].analyses[0].result?.pnlEur, null);
  assert(Math.abs(state.records[0].analyses[0].result!.alpha! - .05) < 1e-10);
  commit([closed]); analyzePendingBacktests();
  assert.equal(getBacktestState().records[0].analyses.length, 1);
  retryBacktest(key);
  assert.equal(getBacktestState().records[0].analyses.length, 2);
  assert.deepEqual(getBacktestState().records[0].analyses[0], state.records[0].analyses[0]);
  // Replays cannot restate a settled fill; keep differing evidence visible.
  commit([{ ...closed, exitPrice: 120, realizedPnl: 200 }]);
  assert.equal(getBacktestState().records[0].position.exitPrice, 110);
  assert.equal(getBacktestState().records[0].replayChanged, true);
  assert.equal(getBacktestState().records[0].replayChanges.length, 1);
  // Each depot and subsequent entry has a distinct permanent identity.
  getDb().transaction(() => { recordBacktestBook('Insider Only', config, [closed]); recordBacktestClosures('Insider Only', config, [closed]); })();
  commit([closed, { ...second, signalId: null }]);
  assert.equal(getBacktestState().records.length, 3);
  assert.equal(getBacktestState().records.find(r => r.position.entryDate === second.entryDate)!.snapshot.provenance, 'missing');
  // Old entries must never acquire a newer source envelope.
  const historical = { ...p, entryDate: '2020-01-01' };
  recordBacktestBook('Historical', config, [historical]);
  assert.equal(getBacktestState().records.find(r => r.portfolio === 'Historical')!.snapshot.provenance, 'missing');
  // Failure is durable, retriable, and cannot prevent a committed close.
  const broken = { ...closed, ticker: 'BROKEN', costBasis: 0 };
  recordBacktestBook('Failure fixture', config, [broken]); recordBacktestClosures('Failure fixture', config, [broken]); analyzePendingBacktests();
  assert.equal(getBacktestState().records.find(r => r.portfolio === 'Failure fixture')!.status, 'failed');
  const saved = getBacktestState().records;
  clearPortfolio();
  assert.deepEqual(getBacktestState().records, saved);
  closeDatabase(); initDatabase(file);
  assert.deepEqual(getBacktestState().records, saved);
  assert.equal(getDb().pragma('quick_check', { simple: true }), 'ok');
  console.log('Backtest: atomic buys, immutable full snapshots, source changes, closes, retries, depot isolation, re-entry, legacy data, replay drift, failures, reset and SQLite reopen passed.');
} finally {
  closeDatabase(); fs.rmSync(dir, { recursive: true, force: true });
}
