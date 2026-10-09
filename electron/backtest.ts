import { createHash, randomUUID } from 'node:crypto';
import type { Signal, PortfolioConfig, PortfolioPosition } from '../src/types';
import * as parameters from '../src/types';
import type { BacktestState, BacktestRecord, BacktestSnapshot, BacktestTrade, BacktestAnalysis, DecisionEnvelope, DecisionContext } from '../src/types/backtest';
import { analyzeBacktest } from '../src/lib/backtest-analysis';
import { getDb } from './database';
import { utcInstantMs } from '../src/lib/utcDate';

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
};
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function economicPosition(p: PortfolioPosition): Omit<PortfolioPosition, 'id' | 'signalId'> {
  const { id, signalId, ...evidence } = p;
  return evidence;
}
export const decisionKey = (signal: Pick<Signal, 'ticker' | 'scrapedAt'>): string => hash([signal.ticker, signal.scrapedAt]);
export const strategyKey = (config: PortfolioConfig): string => hash(config);
export function backtestInstance(): string {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO app_settings (key,value) VALUES (?,?)').run('backtest_instance', randomUUID());
  return (db.prepare('SELECT value FROM app_settings WHERE key=?').get('backtest_instance') as { value: string }).value;
}
export const purchaseKey = (portfolio: string, config: PortfolioConfig, p: PortfolioPosition): string => hash([backtestInstance(), portfolio, strategyKey(config), p.ticker, p.entryDate]);

/** Called inside signal insertion's transaction, before any rolling pruning. */
export function captureDecision(signal: Signal, context: DecisionContext | null = null): void {
  const envelope: DecisionEnvelope = {
    key: decisionKey(signal), capturedAt: new Date().toISOString(), logicVersion: '1.7.0-scoring-1',
    signal, context,
    parameters: Object.fromEntries(Object.entries(parameters).filter(([k, v]) =>
      /^[A-Z][A-Z_0-9]+$/.test(k) && typeof v !== 'function' && !['DEFAULT_SETTINGS', 'SCRAPER_SOURCES', 'LOGIN_PLATFORMS', 'SIDE_PIPELINE_SOURCES'].includes(k))),
  };
  getDb().prepare('INSERT OR IGNORE INTO backtest_decisions VALUES (?, ?)').run(envelope.key, JSON.stringify(envelope));
}

function lookupDecision(p: PortfolioPosition): DecisionEnvelope | null {
  // IDs are local SQLite identities; exported linkage uses ticker + source timestamp.
  const row = p.signalId == null ? undefined : getDb().prepare('SELECT ticker, scraped_at AS scrapedAt FROM signals WHERE id=?').get(p.signalId) as { ticker: string; scrapedAt: string } | undefined;
  if (!row || row.ticker !== p.ticker) return null;
  const saved = getDb().prepare('SELECT payload FROM backtest_decisions WHERE key=?').get(decisionKey(row)) as { payload: string } | undefined;
  if (!saved) return null;
  const e = JSON.parse(saved.payload) as DecisionEnvelope;
  // Never attach new data to a historical simulated entry. Envelope must predate
  // the auction used as the fill; daily-only timing follows existing engine.
  const executionTime = Date.parse(`${p.entryDate}T20:00:00Z`);
  const observedAt = utcInstantMs(e.signal.scrapedAt);
  if (observedAt == null || !Number.isFinite(Date.parse(e.capturedAt)) || Date.parse(e.capturedAt) > executionTime || observedAt > executionTime || e.signal.score !== p.entryScore) return null;
  return e;
}

/** Must be in the SAME transaction as the successful book write. No analysis here. */
export function recordBacktestBook(portfolio: string, config: PortfolioConfig, positions: readonly PortfolioPosition[], legacy = false): void {
  const db = getDb();
  const now = new Date().toISOString();
  for (const p of positions) {
    const key = purchaseKey(portfolio, config, p);
    const exists = db.prepare('SELECT snapshot FROM backtest_purchases WHERE key=?').get(key) as { snapshot: string } | undefined;
    if (exists) {
      const old = (JSON.parse(exists.snapshot) as BacktestSnapshot).execution;
      const closure = db.prepare('SELECT payload FROM backtest_closures WHERE purchase_key=?').get(key) as { payload: string } | undefined;
      if (old.entryPrice !== p.entryPrice || old.shares !== p.shares || old.entryScore !== p.entryScore ||
          (closure && canonical(economicPosition(JSON.parse(closure.payload))) !== canonical(economicPosition(p)))) {
        db.prepare('INSERT OR IGNORE INTO backtest_replays VALUES (?, ?, ?)').run(hash([key, economicPosition(p)]), key, JSON.stringify({ recordedAt: now, position: p }));
      }
    }
    if (!exists) {
      const decision = legacy ? null : lookupDecision(p);
      const execution = { ...p, exitDate: null, exitPrice: null, exitReason: null, realizedPnl: null, spyExit: null, highWaterClose: null };
      const snapshot: BacktestSnapshot = {
        capturedAt: now, provenance: decision ? 'original' : 'missing', decision,
        missingReason: decision ? null : 'Kein originaler, vor dem Kauf gespeicherter Alert-Zustand vorhanden. Historische Werte werden nicht durch aktuelle Alerts ersetzt.',
        config, execution, currency: 'USD', fees: null, slippageBps: config.slippageBps,
      };
      db.prepare('INSERT OR IGNORE INTO backtest_purchases VALUES (?, ?, ?, ?, ?)').run(key, portfolio, `${backtestInstance()}:${portfolio}`, strategyKey(config), JSON.stringify(snapshot));
      const buy: BacktestTrade = { key: `${key}:buy`, side: 'buy', recordedAt: now, date: p.entryDate, price: p.entryPrice, shares: p.shares, value: p.costBasis, fees: null, reason: null };
      db.prepare('INSERT OR IGNORE INTO backtest_trades VALUES (?, ?, ?)').run(buy.key, key, JSON.stringify(buy));
    }
    if (p.exitDate && p.exitPrice != null) {
      const sell: BacktestTrade = { key: `${key}:sell`, side: 'sell', recordedAt: now, date: p.exitDate, price: p.exitPrice, shares: p.shares, value: p.exitPrice * p.shares, fees: null, reason: p.exitReason };
      db.prepare('INSERT OR IGNORE INTO backtest_trades VALUES (?, ?, ?)').run(sell.key, key, JSON.stringify(sell));
    }
  }
}

export function getBacktestState(): BacktestState {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM backtest_purchases ORDER BY rowid DESC').all() as { key: string; portfolio: string; portfolio_id: string; strategy: string; snapshot: string }[];
  const decode = <T>(table: string, key: string): T[] => (db.prepare(`SELECT payload FROM ${table} WHERE purchase_key=? ORDER BY rowid`).all(key) as { payload: string }[]).map(r => JSON.parse(r.payload));
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), readOnly: false, records: rows.map(r => {
    const snapshot = JSON.parse(r.snapshot) as BacktestSnapshot;
    const trades = decode<BacktestTrade>('backtest_trades', r.key);
    const analyses = decode<BacktestAnalysis>('backtest_analyses', r.key).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sell = trades.find(t => t.side === 'sell');
    const p = snapshot.execution;
    const position: PortfolioPosition = { ...p, ...(sell ? { exitDate: sell.date, exitPrice: sell.price, exitReason: sell.reason as PortfolioPosition['exitReason'], realizedPnl: sell.value - p.costBasis } : {}) };
    // SPY close is preserved separately in an immutable analysis input at first close.
    const closure = decode<PortfolioPosition>('backtest_closures', r.key).at(0);
    const latest = analyses.at(-1);
    return { key: r.key, portfolio: r.portfolio, portfolioId: r.portfolio_id, strategy: r.strategy, snapshot, position: closure ?? position, trades, analyses,
      status: !sell ? 'open' : latest?.status ?? 'pending',
      replayChanges: decode<BacktestRecord['replayChanges'][number]>('backtest_replays', r.key),
      replayChanged: !!db.prepare('SELECT key FROM backtest_replays WHERE purchase_key=? LIMIT 1').get(r.key) } as BacktestRecord;
  }) };
}

export function recordBacktestClosures(portfolio: string, config: PortfolioConfig, positions: readonly PortfolioPosition[]): void {
  for (const p of positions.filter(p => p.exitDate)) {
    const key = purchaseKey(portfolio, config, p);
    getDb().prepare('INSERT OR IGNORE INTO backtest_closures VALUES (?, ?, ?)').run(`${key}:close`, key, JSON.stringify(p));
  }
}

/** Persist failures as analysis versions. A failed analyzer never rolls back a trade. */
export function retryBacktest(key: string): BacktestState {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Ungültige Position');
  const r = getBacktestState().records.find(r => r.key === key);
  if (!r || r.status === 'open') throw new Error('Geschlossene Position nicht gefunden');
  const id = randomUUID();
  const now = new Date().toISOString();
  let analysis: BacktestAnalysis;
  try { analysis = analyzeBacktest(r, id, now); }
  catch (err) {
    analysis = { id, createdAt: now, version: '1.7.0-observational-1', status: 'failed', error: err instanceof Error ? err.message : 'Analyse fehlgeschlagen', input: { snapshot: r.snapshot, trades: r.trades, position: r.position }, result: null, factors: [], observations: [], expectations: [], explanations: [], limitations: [], hypotheses: [] };
  }
  getDb().prepare('INSERT INTO backtest_analyses VALUES (?, ?, ?)').run(id, key, JSON.stringify(analysis));
  return getBacktestState();
}

export function analyzePendingBacktests(): void {
  try { for (const r of getBacktestState().records.filter(r => r.status === 'pending')) retryBacktest(r.key); }
  catch (err) { console.error('[backtest] analysis pending; retry available', err); }
}
