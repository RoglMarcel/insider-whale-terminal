import { describe, it, expect } from 'vitest';
import { spearman, designEffect, icInterval, bucketMonotonicity, type Row } from '../scripts/analyze-score';

const row = (ticker: string, score: number, alpha: number, entryDate = '2026-07-10'): Row => ({
  ticker, score, alpha, entryDate, hasContent: true,
});

describe('spearman', () => {
  it('is +1 for a perfectly increasing relation and −1 for a decreasing one', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    expect(spearman(xs, xs)).toBeCloseTo(1, 10);
    expect(spearman(xs, [...xs].reverse())).toBeCloseTo(-1, 10);
  });
  it('is rank-based, so a monotone transform does not change it', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = xs.map((x) => Math.exp(x / 5));
    expect(spearman(xs, ys)).toBeCloseTo(1, 10);
  });
  it('handles ties with average ranks instead of dying', () => {
    const xs = [1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5];
    const ys = [1, 2, 1, 2, 3, 3, 4, 3, 5, 4, 5, 6];
    const r = spearman(xs, ys);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r as number)).toBe(true);
  });
  it('refuses to answer below n = 10', () => {
    expect(spearman([1, 2, 3], [1, 2, 3])).toBeNull();
  });
  it('returns null when one side is constant (no ranking possible)', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    expect(spearman(xs, new Array(20).fill(7))).toBeNull();
  });
});

describe('designEffect', () => {
  it('is 1 when every observation is its own ticker', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`T${i}`, i, i / 100));
    const d = designEffect(rows);
    expect(d.clusters).toBe(40);
    expect(d.m).toBe(1);
    expect(d.deff).toBeCloseTo(1, 10);
  });
  it('grows with repeated tickers whose outcomes are identical (ρ → 1)', () => {
    // 10 tickers × 4 identical observations each: the extra rows carry no
    // information, so n_eff must collapse toward the number of tickers.
    const rows: Row[] = [];
    for (let t = 0; t < 10; t++) for (let k = 0; k < 4; k++) rows.push(row(`T${t}`, t * 10, t / 100));
    const d = designEffect(rows);
    expect(d.m).toBe(4);
    expect(d.rho).toBeGreaterThan(0.9);
    expect(d.deff).toBeGreaterThan(3.5);
    expect(d.n / d.deff).toBeLessThan(12);
  });
  it('stays at 1 when repeats are uncorrelated', () => {
    const rows: Row[] = [];
    for (let t = 0; t < 10; t++) for (let k = 0; k < 4; k++) rows.push(row(`T${t}`, t, ((t * 7 + k * 13) % 20) / 100));
    expect(designEffect(rows).deff).toBeLessThan(2);
  });
  it('never returns a design effect below 1', () => {
    expect(designEffect([]).deff).toBe(1);
    expect(designEffect([row('A', 1, 0.1)]).deff).toBeGreaterThanOrEqual(1);
  });
});

describe('icInterval', () => {
  it('brackets the point estimate', () => {
    const [lo, hi] = icInterval(0.2, 500);
    expect(lo).toBeLessThan(0.2);
    expect(hi).toBeGreaterThan(0.2);
  });
  it('is wider at a smaller effective sample size', () => {
    const wide = icInterval(0.2, 50);
    const narrow = icInterval(0.2, 5000);
    expect(wide[1] - wide[0]).toBeGreaterThan(narrow[1] - narrow[0]);
  });
  it('refuses degenerate input instead of returning nonsense', () => {
    expect(icInterval(1, 100).every(Number.isNaN)).toBe(true);
    expect(icInterval(0.2, 3).every(Number.isNaN)).toBe(true);
  });
});

describe('bucketMonotonicity', () => {
  it('is 1 for a perfectly increasing bucket series', () => {
    expect(bucketMonotonicity([-1, 0, 1, 2])).toBe(1);
  });
  it('is 0 for a perfectly decreasing one', () => {
    expect(bucketMonotonicity([2, 1, 0, -1])).toBe(0);
  });
  it('ignores buckets that were excluded for being too small (null)', () => {
    expect(bucketMonotonicity([1, null, 2, null, 3])).toBe(1);
  });
  it('reports the U-shape the single IC hides', () => {
    // The live 10-day shape: 0-19 positive, 20-39 negative, 40-59 less negative.
    expect(bucketMonotonicity([1.07, -2.64, -0.12])).toBeCloseTo(0.5, 10);
  });
  it('makes no claim below two usable buckets', () => {
    expect(bucketMonotonicity([1])).toBeNull();
    expect(bucketMonotonicity([null, null])).toBeNull();
    expect(bucketMonotonicity([])).toBeNull();
  });
});
