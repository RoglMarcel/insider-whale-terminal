import { describe, expect, it } from 'vitest';
import { summarizeInsiderTrades, mergeInsiderSaleVolume } from '../src/lib/insider-summary';
import { scoreTicker } from '../electron/scoring';
import { aggregate, trade, option } from './helpers';

const now = Date.parse('2026-10-30T12:00:00Z');
const sale = (over = {}) => trade({ transactionType: 'S - Sale', tradeDate: '2026-10-07', filingDate: '2026-10-09', shares: 100000, price: 45.02, value: 4502000, ...over });

describe('insider activity is distinct from buyer conviction', () => {
  it('shows both SMCI sellers, their price, volume and dates without inventing buying', () => {
    const trades = [sale({ insiderName: 'Liu Liang Chiu-Chu Sara' }), sale({ insiderName: 'Liang Charles' })];
    const summary = summarizeInsiderTrades(trades, now);
    expect(summary).toMatchObject({ count: 2, buys: 0, sells: 9004000, saleOnly: true, tradeDate: '2026-10-07', filingDate: '2026-10-09' });
    expect(summary.salePrice).toBeCloseTo(45.02);
    const scored = scoreTicker(aggregate({ trades, options: [option({ scrapedAt: new Date(now).toISOString() })] }), undefined, now);
    expect(scored.insiderCount).toBe(0);
    expect(scored.totalDollarVolume).toBe(0);
  });
  it('keeps buy and sale averages separate and counts people once across sides', () => {
    const summary = summarizeInsiderTrades([sale(), trade({ tradeDate: '2026-10-08', shares: 100, price: 20, value: 2000 }), trade({ insiderName: 'Other Person', tradeDate: '2026-10-08', shares: 300, price: 40, value: 12000 })], now);
    expect(summary).toMatchObject({ count: 2, buys: 14000, sells: 4502000, buyPrice: 35, saleOnly: false });
  });
  it('excludes quarantined, future and invalid rows from totals', () => {
    expect(summarizeInsiderTrades([sale({ tradeDate: '2027-01-01' }), sale({ value: NaN }), sale({ dateStatus: 'missing' })], now).count).toBe(0);
    expect(summarizeInsiderTrades([], now)).toMatchObject({ count: 0, buys: 0, sells: 0, saleOnly: false });
  });
  it('does not report awards or gifts as sale proceeds', () => {
    const summary = summarizeInsiderTrades([sale({ transactionType: 'A - Award' }), sale({ transactionType: 'Gift Given' })], now);
    expect(summary.sells).toBe(0);
    expect(summary.buys).toBe(0);
  });
  it('recovers missing sale-feed coverage without doubling overlapping totals', () => {
    expect(mergeInsiderSaleVolume(0, 9004000)).toBe(9004000);
    expect(mergeInsiderSaleVolume(9004000, 9004000)).toBe(9004000);
    expect(mergeInsiderSaleVolume(12000000, 9004000)).toBe(12000000);
  });
});
