import { describe, expect, it } from 'vitest';
import { buildInsiderOnly, insiderOnlyConfig } from '../src/lib/insider-only';
import { simulatePortfolio, type PortfolioSimInput } from '../src/lib/portfolio-rules';
import { DEFAULT_PORTFOLIO_CONFIG, type PortfolioCandidate } from '../src/types';

const days = ['2026-09-01', '2026-09-02', '2026-09-03'];
const series = (values: number[]) => Object.fromEntries(values.map((v, i) => [days[i], v]));
const candidate = (ticker: string, score = 80): PortfolioCandidate => ({ ticker, score, earliestDate: days[0], signalId: null, source: 'signal' });
const fixture = (): PortfolioSimInput => ({
  config: { ...DEFAULT_PORTFOLIO_CONFIG, slippageBps: 0 }, tradingDays: days,
  spy: series([100, 110, 120]), prices: { AAA: series([100, 100, 110]) }, candidates: [candidate('AAA')],
});
const build = (input = fixture()) => buildInsiderOnly(input, '2026-09-23T12:00:00Z');

describe('independent insider-only portfolio', () => {
  it('uses $10k, a fixed 20% entry ticket and idle cash while sharing the benchmark', () => {
    const input = fixture(), before = structuredClone(input);
    const result = build(input).state, overlay = simulatePortfolio(input);
    expect(result.config.startingCash).toBe(10000);
    expect(result.open[0].costBasis).toBe(2000);
    expect(result.equity.at(-1)!.equity).toBe(10200);
    expect(result.equity.map(p => p.benchmark)).toEqual(overlay.equity.map(p => p.benchmark));
    expect(result.equity.at(-1)!.equity).not.toBe(overlay.equity.at(-1)!.equity);
    expect(input).toEqual(before);
    expect(result.config.cashPolicy).toBe('idle');
  });
  it('does not increase allocation for higher scores or a repeated alert on an open stock', () => {
    const input = fixture();
    input.candidates.push({ ...candidate('AAA', 99), earliestDate: days[1] }, candidate('BBB', 71));
    input.prices.BBB = series([100,100,100]);
    const state = build(input).state;
    expect(state.open).toHaveLength(2);
    expect(state.open.map(p => p.costBasis)).toEqual([2000,2000]);
  });
  it('limits the book to five positions and preserves the minimum funded ticket', () => {
    const input = fixture();
    input.candidates = 'ABCDEF'.split('').map(t => candidate(t));
    input.prices = Object.fromEntries(input.candidates.map(c => [c.ticker,series([100,100,100])]));
    const state = build(input).state;
    expect(state.open).toHaveLength(5);
    expect(state.open.every(p => p.costBasis === 2000)).toBe(true);
    expect(state.meta.skippedCap + state.meta.skippedNoCash).toBeGreaterThan(0);
  });
  it('carries the last valid quote without selling during a price outage', () => {
    const input = fixture();
    input.prices.AAA = series([100]);
    const state = build(input).state;
    expect(state.closed).toHaveLength(0);
    expect(state.open).toHaveLength(1);
    expect(state.open[0].priceStale).toBe(true);
    expect(state.open[0].priceAsOf).toBe(days[0]);
    expect(state.equity.at(-1)!.equity).toBe(10000);
  });
  it('is repeatable, identifies retrospective history and retains original exit rules', () => {
    const input = fixture();
    expect(build(input)).toEqual(build(input));
    expect(build(input).definedAt).toBe('2026-09-23');
    expect(build(input).state.meta.liveStart).toBe('2026-09-23');
    expect(insiderOnlyConfig(input.config).stopLoss).toBe(input.config.stopLoss);
    expect(insiderOnlyConfig(input.config).maxHoldDays).toBe(input.config.maxHoldDays);
  });
});
