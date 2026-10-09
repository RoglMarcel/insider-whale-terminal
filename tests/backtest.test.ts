import { describe, it, expect, vi } from 'vitest';
import { analyzeBacktest } from '../src/lib/backtest-analysis';
import { retryLocalBacktest, mergeLocalBacktest } from '../src/lib/backtest-web';
import { DEFAULT_PORTFOLIO_CONFIG } from '../src/types';
import type { BacktestRecord, BacktestState } from '../src/types/backtest';

const fixture = (): BacktestRecord => {
  const position = { id: 1, ticker: 'TEST', signalId: null, entryDate: '2026-09-01', entryPrice: 100, shares: 10, costBasis: 1000, entryScore: 80, targetWeight: .1, highWaterClose: 100, exitDate: '2026-09-11', exitPrice: 90, exitReason: 'stop_loss' as const, realizedPnl: -100, spyEntry: 100, spyExit: 80 };
  return { key: 'fixture', portfolio: 'Test', portfolioId: 'test', strategy: 'v1', position,
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
