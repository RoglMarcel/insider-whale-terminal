import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { calculateFairValue, discountedCashFlow, fadingCashFlow, realOptionCall } from '../electron/fairValue';
import { fetchFairValue, parseFundamentals, parseFundamentalNumber } from '../electron/scraper/fairValue';
import { scoreTicker } from '../electron/scoring';
import { aggregate, trade } from './helpers';
import { withTimeout } from '../electron/scraper/cancellation';
import { clearPublicHtmlCache } from '../electron/scraper/publicHtml';

const now = Date.parse('2026-10-03T12:00:00Z');
function data(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, source: 'https://example.com/filing', fetchedAt: new Date(now).toISOString() }]));
}
beforeEach(()=>vi.stubEnv('ANALYSIS_CATALOGUE_BUILD','1'));
afterEach(() => {vi.unstubAllGlobals();vi.unstubAllEnvs();clearPublicHtmlCache();});
describe('fair value calculations and scoring', () => {
  it('has a neutral structured result when every source is missing', () => {
    const r = calculateFairValue({}, now);
    expect(r.status).toBe('unavailable');
    expect(r.fairValue).toBeNull();
    expect(r.multiplier).toBe(1);
    expect(r.weight).toBe(0);
    expect(r.models).toHaveLength(26);
  });
  it('does not manufacture positive value from losses or a market quote', () => {
    expect(calculateFairValue(data({ price: 50, eps: -3, bookPerShare: -10 }), now).fairValue).toBeNull();
  });
  it('labels and downweights a policy fallback, with a single 40% safety discount', () => {
    const r = calculateFairValue(data({ eps: 10, price: 20 }), now);
    expect(r.fairValue).toBe(125);
    expect(r.entryPrice).toBe(75);
    expect(r.status).toBe('fallback');
    expect(r.level).toBe(1);
    expect(r.weight).toBe(0.075);
    expect(r.recommendation).toBe('undervalued');
    expect(r.multiplier).toBeCloseTo(1.01125);
  });
  it('separates undervaluation from the safety-adjusted entry threshold', () => {
    const r=calculateFairValue(data({ eps: 10, price: 80 }), now);
    expect(r.recommendation).toBe('undervalued');
    expect(r.safetyMarginMet).toBe(false);
    expect(r.multiplier).toBe(1);
    expect(r.mispricingPct).toBeCloseTo(-36);
  });
  it('rejects stale/future/invalid observations', () => {
    const inputs = data({ eps: 5, price: Infinity, bookPerShare: 10 });
    inputs.eps.fetchedAt = '2020-01-01';
    inputs.bookPerShare.fetchedAt = '2099-01-01';
    expect(calculateFairValue(inputs, now).status).toBe('unavailable');
  });
  it('evaluates relative benchmarks only with actual benchmark inputs', () => {
    const r = calculateFairValue(data({ eps: 2, peerPE: 12, bookPerShare: 10, peerPB: 2, price: 10 }), now);
    expect(r.level).toBe(2);
    expect(r.fairValue).toBe(22);
    expect(r.marginOfSafety).toBe(0.3);
  });
  it('matches a zero-growth perpetuity and rejects invalid terminal rates', () => {
    expect(discountedCashFlow(10, 0, 0.1, 0)).toBeCloseTo(100);
    expect(discountedCashFlow(10, 0.03, 0.02, 0.02)).toBeNaN();
  });
  it('bridges enterprise value to equity without adding cash to FCFE', () => {
    const r = calculateFairValue(data({ fcff: 100, wacc: 0.1, shares: 10, cash: 20, debt: 50 }), now);
    expect(r.models[0].value).toBeCloseTo((fadingCashFlow(100, 0.02, 0.1, 0.025) - 30) / 10);
  });
  it('does not promote default discount rates or unrelated WACC to level 3', () => {
    const r = calculateFairValue(data({ fcfePerShare: 10, wacc: 0.1, shares: 10, cash: 20, debt: 50, eps: 3, price: 30, revenue: 200, ebit: 30, dividend: 1 }), now);
    expect(r.level).toBe(1);
    expect(calculateFairValue({ ...r.inputs, ...data({ costEquity: 0.12 }) }, now).level).toBe(1);
  });
  it('persists the valuation snapshot in the score and applies its multiplier', () => {
    const fairValue = calculateFairValue(data({ price: 10, eps: 10 }), now);
    const scored = scoreTicker(aggregate({ trades: [trade()], fairValue }), undefined, now);
    expect(scored.breakdown.fairValue).toEqual(fairValue);
    expect(scored.breakdown.valuationMultiplier).toBe(fairValue.multiplier);
    expect(JSON.parse(JSON.stringify(scored.breakdown)).fairValue).toEqual(fairValue);
  });
});
describe('fundamental adapters', () => {
  it('preserves signs, missing values and zeroes', () => {
    expect(parseFundamentalNumber('-1.2B')).toBe(-1.2e9);
    expect(parseFundamentalNumber('0')).toBe(0);
    expect(parseFundamentalNumber('n/a')).toBeUndefined();
    expect(parseFundamentalNumber('12.3foo')).toBeUndefined();
  });
  it('parses nested markup, exact labels and same-page derived inputs', () => {
    const rows = [['Market Cap', '100B'], ['Shares Outstanding', '1B'], ['Free Cash Flow', '5B'], ['Net Borrowing', '-1B'], ['EPS Growth Forecast (3Y)', '12%']];
    const html = rows.map(([k, v]) => `<tr><td><span>${k}</span></td><td><b>${v}</b></td></tr>`).join('');
    const r = parseFundamentals(html, 'https://example.com', new Date(now).toISOString(), 'stockanalysis');
    expect(r.price).toBeUndefined();
    expect(r.fcfePerShare.value).toBe(4);
    expect(r.fcfProxyPerShare.value).toBe(5);
    expect(r.epsGrowth.value).toBe(0.12);
    expect(r.eps).toBeUndefined();
  });
  it('tries fallback provider after blocked source without throwing', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(new Response('<title>TEST - Test Stock</title><tr><td>EPS (ttm)</td><td>2</td><td>Price</td><td>10</td></tr>'));
    vi.stubGlobal('fetch', mock);
    const result = await fetchFairValue('TEST');
    expect(mock).toHaveBeenCalledTimes(4);
    expect(result.status).toBe('fallback');
    expect(result.price).toBe(10);
    expect(result.warnings.join(' ')).toContain('403');
  });
  it('survives total source failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await fetchFairValue('TEST')).status).toBe('unavailable');
  });
  it('honors phase cancellation instead of continuing fallback requests', async () => {
    const mock = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    vi.stubGlobal('fetch', mock);
    expect(await withTimeout(() => fetchFairValue('TEST'), 10, null)).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
