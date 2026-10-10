import { normalizeBacktestState, mergePublishedBacktest } from '../src/lib/backtest-records';
import { describe, it, expect, vi } from 'vitest';
import { analyzeBacktest } from '../src/lib/backtest-analysis';
import { retryLocalBacktest, mergeLocalBacktest } from '../src/lib/backtest-web';
import { DEFAULT_PORTFOLIO_CONFIG } from '../src/types';
import type { BacktestRecord, BacktestState } from '../src/types/backtest';

const fixture = (): BacktestRecord => {
  const position = { id: 1, ticker: 'TEST', signalId: null, entryDate: '2026-09-01', entryPrice: 100, shares: 10, costBasis: 1000, entryScore: 80, targetWeight: .1, highWaterClose: 100, exitDate: '2026-09-11', exitPrice: 90, exitReason: 'stop_loss' as const, realizedPnl: -100, spyEntry: 100, spyExit: 80 };
  return { key: 'fixture', portfolio: 'Hauptdepot', portfolioId: 'test', strategy: 'v1', position,
    snapshot: { capturedAt: '2026-09-01', provenance: 'missing', missingReason: 'Historischer Snapshot fehlt', decision: null, config: DEFAULT_PORTFOLIO_CONFIG, execution: position, currency: 'USD', fees: null, slippageBps: 5 },
    trades: [], analyses: [], status: 'pending', replayChanged: false, replayChanges: [] };
};
describe('backtest evidence', () => {
  it('separates absolute loss and benchmark outperformance without inventing attribution', () => {
    const r = fixture(); const before = JSON.stringify(r);
    const a = analyzeBacktest(r, 'one', '2026-10-09');
    expect(a.result).toMatchObject({ pnlUsd: -100, pnlEur: null, holdDays: 10, returnPct: -.1 });
    expect(a.result!.alpha).toBeCloseTo(.1);
    expect(a.expectations.map(e => e.verdict)).toEqual(['contradicted', 'confirmed', 'unknown']);
    expect(a.factors).toEqual([]);
    expect(a.limitations).toContain('Historischer Snapshot fehlt');
    expect(JSON.stringify(r)).toBe(before);
  });
  it('rejects open and invalid positions; reports missing benchmark', () => {
    const r = fixture(); r.position.spyExit = null;
    expect(analyzeBacktest(r, 'x', 'now').result!.benchmarkPct).toBeNull();
    r.position.exitDate = null as unknown as string;
    expect(() => analyzeBacktest(r, 'x', 'now')).toThrow();
  });
  it('persists local web versions without changing published data', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
    const state: BacktestState = { schemaVersion: 1, generatedAt: 'now', records: [fixture()], readOnly: true };
    const before = JSON.stringify(state);
    retryLocalBacktest(state, 'fixture');
    const second = retryLocalBacktest(state, 'fixture');
    expect(second.records[0].analyses).toHaveLength(2);
    expect(mergeLocalBacktest(state).records[0].analyses).toEqual(second.records[0].analyses);
    expect(JSON.stringify(state)).toBe(before);
    storage.set('backtest-analysis-versions-v1', 'invalid JSON');
    expect(mergeLocalBacktest(state).records).toEqual(state.records);
    expect(mergeLocalBacktest(state).localError).toBeTruthy();
    expect(() => retryLocalBacktest(state, 'fixture')).toThrow();
    vi.unstubAllGlobals();
  });
});

describe('one archived main-depot purchase', () => {
  const state = (records: BacktestRecord[]): BacktestState => ({ schemaVersion: 1, generatedAt: 'published-date', records, readOnly: true });
  it('omits comparison depots and preserves their original inputs', () => {
    const main = fixture(); const comparison = { ...fixture(), key: 'secondary', portfolio: 'Insider Only' };
    const source = state([comparison, main]); const before = JSON.stringify(source);
    expect(normalizeBacktestState(source).records).toEqual([main]);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('coalesces device copies and keeps every original for export', () => {
    const one = { ...fixture(), key: 'one', portfolioId: 'device-one:Hauptdepot' };
    const two = { ...fixture(), key: 'two', portfolioId: 'device-two:Hauptdepot', snapshot: { ...fixture().snapshot, execution: { ...fixture().position, id: 999, signalId: 999 } } };
    const source = state([two, one]); const before = JSON.stringify(source);
    const normalized = normalizeBacktestState(source);
    expect(normalized.records).toHaveLength(1);
    expect(normalized.records[0].sourceRecords?.map(r => r.key).sort()).toEqual(['one','two']);
    expect(JSON.stringify(source)).toBe(before);
    expect(normalizeBacktestState(normalized)).toEqual(normalized);
  });
  it('retains real re-entries, changed strategies and differing fills', () => {
    const one = fixture();
    const later = { ...fixture(), key: 'later', snapshot: { ...fixture().snapshot, execution: { ...fixture().position, entryDate: '2026-10-01' } } };
    const strategy = { ...fixture(), key: 'strategy', strategy: 'other-rules' };
    const fill = { ...fixture(), key: 'fill', snapshot: { ...fixture().snapshot, execution: { ...fixture().position, shares: 20 } } };
    expect(normalizeBacktestState(state([one,later,strategy,fill])).records).toHaveLength(4);
  });
  it('shows the published count and timestamp while keeping local analysis versions', () => {
    const main = fixture(); const extra = { ...fixture(), key:'extra', strategy:'local-experiment' };
    const version = analyzeBacktest(main,'local-version','2026-10-10');
    const local = state([{ ...main, analyses:[version] },extra]);
    const merged = mergePublishedBacktest(state([main]), local);
    expect(merged.generatedAt).toBe('published-date');
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].analyses).toEqual([version]);
    expect(local.records).toHaveLength(2);
  });
});
