/* Exercises the migrated database.ts under Electron's ABI (run via `electron`). */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  initDatabase,
  closeDatabase,
  insertSignals,
  getLatestSignals,
  getFilteredSignals,
  getSignalByTicker,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  startScrapeLog,
  finishScrapeLog,
  getScrapeLogs,
  getTrackRecord,
  upsertTrackRecord,
  clearDatabase,
} from '../electron/database';
import type { Signal, ScoreBreakdown, InsiderTrackRecord } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${cond ? '' : ` — ${detail}`}`);
}

const breakdown: ScoreBreakdown = {
  rankWeight: 10, dollarVolumePoints: 14, typeModifier: 1, clusterMultiplier: 2, timingMultiplier: 1.8,
  optionsScore: 15, optionsTimingMultiplier: 2, freshnessMultiplier: 1, vixMultiplier: 1.15,
  trackRecordMultiplier: 1, valuationMultiplier: 1, comboBonus: 30, optionsBonus: 15, signalAgeDays: 0, rawScore: 900,
  maxPossibleRaw: 2126, normalizedScore: 88, notes: ['combo'],
};

function toLocalYMD(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${date}`;
}

function makeSignal(ticker: string, score: number, scrapedAt: string, ageDays = 0): Signal {
  const tDate = toLocalYMD(Date.now() - ageDays * 86400000);
  const fDate = toLocalYMD(Date.now() - Math.max(0, ageDays - 1) * 86400000);
  return {
    ticker, companyName: `${ticker} Inc.`, score,
    convictionLevel: score >= 80 ? 'HIGH' : score >= 50 ? 'WATCH' : 'LOW',
    totalDollarVolume: 1_234_567, insiderCount: 3, topInsiderRole: 'CEO', topInsiderName: 'Jane Doe',
    optionsActivity: [{ ticker, type: 'call', sentiment: 'bullish', notional: 2_000_000, dte: 14, isSweep: true, source: 'barchart' }],
    rawTrades: [{ ticker, insiderName: 'Jane Doe', role: 'CEO', transactionType: 'P - Purchase', tradeDate: tDate, shares: 1000, value: 1_234_567, source: 'openinsider', insiderUrl: 'http://openinsider.com/insider/Jane-Doe/123' }],
    breakdown, scrapedAt, sourceUrls: ['http://openinsider.com/latest-insider-purchases-25k'],
    tradeDate: tDate,
    filingDate: fDate,
    lateFiling: true, comboSignal: score >= 80, comboDetectedAt: score >= 80 ? scrapedAt : null,
    earningsDate: '2026-06-20', earningsTiming: 'AMC', daysToEarnings: 6,
  };
}

const dbPath = path.join(os.tmpdir(), `it-ext-verify-${Date.now()}.db`);
console.log(`DB: ${dbPath}\n`);

try {
  initDatabase(dbPath); // runs migrations

  const now = new Date().toISOString();
  insertSignals([makeSignal('NVDA', 88, now, 0), makeSignal('AAPL', 60, now, 3), makeSignal('OLD', 55, now, 20)]);

  // Feature 1/4/5 — new columns round-trip (implicitly proves migrations ran).
  const nvda = getSignalByTicker('NVDA');
  check('migrated columns round-trip', !!nvda && nvda.lateFiling === true && nvda.comboSignal === true);
  check('earnings round-trip', !!nvda && nvda.earningsTiming === 'AMC' && nvda.daysToEarnings === 6);
  check('extended breakdown round-trip', !!nvda && nvda.breakdown.comboBonus === 30 && nvda.breakdown.vixMultiplier === 1.15);
  check('insiderUrl round-trip', !!nvda && !!nvda.rawTrades[0].insiderUrl?.includes('/insider/'));
  check('3 latest signals', getLatestSignals().length === 3);

  // Feature 7 — filtered query.
  check('filter 24h → 1 (NVDA only)', getFilteredSignals({ timeRange: '24h', type: 'all', conviction: 'all', bigPlayersOnly: false }).length === 1);
  check('filter week → excludes 20d-old', getFilteredSignals({ timeRange: 'week', type: 'all', conviction: 'all', bigPlayersOnly: false }).every((s) => s.ticker !== 'OLD'));
  check('filter combo → NVDA only', getFilteredSignals({ timeRange: 'all', type: 'combo', conviction: 'all', bigPlayersOnly: false }).length === 1);
  check('filter HIGH → NVDA only', getFilteredSignals({ timeRange: 'all', type: 'all', conviction: 'HIGH', bigPlayersOnly: false }).length === 1);

  // Feature 8 — scrape log VIX.
  const logId = startScrapeLog(['openinsider']);
  finishScrapeLog(logId, { signalsFound: 3, status: 'success', sourcesScraped: ['openinsider'], vixAtScrape: 27.3 });
  check('scrape log VIX stored', getScrapeLogs()[0].vixAtScrape === 27.3);

  // Feature 6 — track record cache.
  const tr: InsiderTrackRecord = {
    insiderName: 'Jane Doe', insiderRole: 'CEO', totalTrades: 9, profitable3m: 7, profitable6m: 6,
    accuracy3m: 7 / 9, accuracy6m: 6 / 9, avgReturn3m: 12.4, lastUpdated: now,
    recentTrades: [{ tradeDate: '2026-01-01', ticker: 'AMD', transactionType: 'P', return3m: 8, wasProfitable3m: true }],
  };
  upsertTrackRecord(tr);
  const got = getTrackRecord('Jane Doe');
  check('track record cached', !!got && got.totalTrades === 9 && Math.round((got.accuracy3m ?? 0) * 100) === 78);
  check('track record recentTrades round-trip', !!got && got.recentTrades.length === 1);
  upsertTrackRecord({ ...tr, totalTrades: 12 }); // upsert overwrites
  check('track record upsert overwrites', getTrackRecord('Jane Doe')?.totalTrades === 12);

  // Watchlist still works.
  addToWatchlist('NVDA');
  check('watchlist joins signal', getWatchlist()[0]?.signal?.ticker === 'NVDA');
  removeFromWatchlist('NVDA');

  clearDatabase();
  check('signals cleared, track records kept', getLatestSignals().length === 0 && !!getTrackRecord('Jane Doe'));

  closeDatabase();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${ext}`, { force: true });
} catch (err) {
  failures++;
  console.error('THREW:', err);
}

console.log(`\n${failures === 0 ? '✅ ALL DATABASE CHECKS PASSED (migrations + new schema)' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
