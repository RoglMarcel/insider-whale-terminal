/**
 * The fixed aggregates behind `tests/golden-scores.json`.
 *
 * Kept OUT of the .test.ts file so `scripts/gen-golden.ts` can import them
 * without pulling in the vitest runtime.
 */
import type { TickerAggregate } from '../src/types';

export const FROZEN = '2026-08-22T18:00:00Z';
/** Days before the frozen instant, as a LOCAL calendar date (daysBetween's convention). */
function daysBefore(n: number): string {
  const d = new Date(Date.parse(FROZEN) - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const CASES: { name: string; agg: TickerAggregate }[] = [
  {
    name: 'empty aggregate',
    agg: { ticker: 'EMPTY', trades: [], options: [], sourceUrls: [] },
  },
  {
    name: 'single small director buy, unknown cap',
    agg: {
      ticker: 'SMALL',
      trades: [{ ticker: 'SMALL', insiderName: 'Ann Berg', role: 'Director', transactionType: 'P - Purchase', tradeDate: daysBefore(1), shares: 5000, price: 20, value: 100_000, source: 'openinsider' }],
      options: [], sourceUrls: [],
    },
  },
  {
    name: 'clean single CEO buy $600k, fresh, no enrichment',
    agg: {
      ticker: 'CEO1',
      trades: [{ ticker: 'CEO1', insiderName: 'Carl Ott', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(0), shares: 20_000, price: 30, value: 600_000, source: 'openinsider' }],
      options: [], sourceUrls: [],
    },
  },
  {
    name: 'same CEO buy but on a $2T mega-cap',
    agg: {
      ticker: 'MEGA',
      trades: [{ ticker: 'MEGA', insiderName: 'Carl Ott', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(0), shares: 20_000, price: 30, value: 600_000, source: 'openinsider' }],
      options: [], marketCap: 2e12, sourceUrls: [],
    },
  },
  {
    name: 'four-insider cluster into earnings, elevated VIX',
    agg: {
      ticker: 'CLUST',
      trades: [
        { ticker: 'CLUST', insiderName: 'Alice A', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(0), shares: 1000, price: 200, value: 200_000, source: 'openinsider' },
        { ticker: 'CLUST', insiderName: 'Bob B', role: 'Director', transactionType: 'P - Purchase', tradeDate: daysBefore(1), shares: 750, price: 200, value: 150_000, source: 'openinsider' },
        { ticker: 'CLUST', insiderName: 'Carol C', role: 'Chief Financial Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(1), shares: 750, price: 200, value: 150_000, source: 'edgar' },
        { ticker: 'CLUST', insiderName: 'Dan D', role: 'VP Sales', transactionType: 'P - Purchase', tradeDate: daysBefore(2), shares: 500, price: 200, value: 100_000, source: 'finviz' },
      ],
      options: [], daysToEarnings: 3, vix: 30, sourceUrls: [],
    },
  },
  {
    name: 'the same cluster plus a $2.5M bullish sweep (combo)',
    agg: {
      ticker: 'COMBO',
      trades: [
        { ticker: 'COMBO', insiderName: 'Alice A', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(0), shares: 1000, price: 200, value: 200_000, source: 'openinsider' },
        { ticker: 'COMBO', insiderName: 'Bob B', role: 'Director', transactionType: 'P - Purchase', tradeDate: daysBefore(1), shares: 750, price: 200, value: 150_000, source: 'openinsider' },
        { ticker: 'COMBO', insiderName: 'Carol C', role: 'Chief Financial Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(1), shares: 750, price: 200, value: 150_000, source: 'edgar' },
        { ticker: 'COMBO', insiderName: 'Dan D', role: 'VP Sales', transactionType: 'P - Purchase', tradeDate: daysBefore(2), shares: 500, price: 200, value: 100_000, source: 'finviz' },
      ],
      options: [{ ticker: 'COMBO', type: 'call', sentiment: 'bullish', notional: 2_500_000, premiumTotal: 2_500_000, isSweep: true, dte: 14, otmPercent: 20, volOiRatio: 12, source: 'barchart', scrapedAt: FROZEN }],
      daysToEarnings: 3, vix: 30, sourceUrls: [],
    },
  },
  {
    name: 'options-only whale signal',
    agg: {
      ticker: 'WHALE',
      trades: [],
      options: [{ ticker: 'WHALE', type: 'call', sentiment: 'bullish', notional: 3_000_000, premiumTotal: 3_000_000, isSweep: true, dte: 10, otmPercent: 18, volOiRatio: 12, source: 'barchart', scrapedAt: FROZEN }],
      sourceUrls: [],
    },
  },
  {
    name: 'insider buy against put-dominated flow',
    agg: {
      ticker: 'BEAR',
      trades: [{ ticker: 'BEAR', insiderName: 'Eve E', role: 'Director', transactionType: 'P - Purchase', tradeDate: daysBefore(1), shares: 200, price: 100, value: 20_000, source: 'openinsider' }],
      options: [{ ticker: 'BEAR', type: 'put', sentiment: 'bearish', notional: 11_000_000, premiumTotal: 11_000_000, isSweep: true, dte: 10, otmPercent: 20, volOiRatio: 12, source: 'barchart', scrapedAt: FROZEN }],
      sourceUrls: [],
    },
  },
  {
    name: 'stale buy at the freshness floor',
    agg: {
      ticker: 'STALE',
      trades: [{ ticker: 'STALE', insiderName: 'Frank F', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(25), shares: 20_000, price: 50, value: 1_000_000, source: 'openinsider' }],
      options: [], sourceUrls: [],
    },
  },
  {
    name: 'undateable buy (date failed to parse)',
    agg: {
      ticker: 'NODATE',
      trades: [{ ticker: 'NODATE', insiderName: 'Gina G', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: '', shares: 20_000, price: 50, value: 1_000_000, source: 'openinsider' }],
      options: [], sourceUrls: [],
    },
  },
  {
    name: 'award-only aggregate (nothing eligible)',
    agg: {
      ticker: 'AWARD',
      trades: [{ ticker: 'AWARD', insiderName: 'Hank H', role: 'Chief Executive Officer', transactionType: 'A - Award', tradeDate: daysBefore(0), shares: 100_000, price: 90, value: 9_000_000, source: 'edgar' }],
      options: [], sourceUrls: [],
    },
  },
  {
    name: '10b5-1 plan buy (reduced weight)',
    agg: {
      ticker: 'PLAN',
      trades: [{ ticker: 'PLAN', insiderName: 'Ida I', role: 'Chief Executive Officer', transactionType: '10b5-1 Purchase', tradeDate: daysBefore(0), shares: 20_000, price: 30, value: 600_000, source: 'openinsider' }],
      options: [], sourceUrls: [],
    },
  },
  {
    name: 'congressional cluster + insider + options (MEGA tier)',
    agg: {
      ticker: 'MEGAS',
      trades: [{ ticker: 'MEGAS', insiderName: 'Jack J', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(1), shares: 20_000, price: 40, value: 800_000, source: 'openinsider' }],
      options: [{ ticker: 'MEGAS', type: 'call', sentiment: 'bullish', notional: 2_000_000, premiumTotal: 2_000_000, isSweep: true, dte: 20, otmPercent: 12, volOiRatio: 5, source: 'barchart', scrapedAt: FROZEN }],
      politicianTrades: [
        { politician: 'Rep One', chamber: 'House', party: 'Democrat', committee: 'Financial Services', ticker: 'MEGAS', transactionType: 'buy', amountMidpoint: 750_000, tradeDate: daysBefore(5), disclosureDate: daysBefore(2), daysToDisclose: 3, scrapedAt: FROZEN },
        { politician: 'Rep Two', chamber: 'House', party: 'Republican', committee: 'Armed Services', ticker: 'MEGAS', transactionType: 'buy', amountMidpoint: 375_000, tradeDate: daysBefore(6), disclosureDate: daysBefore(2), daysToDisclose: 4, scrapedAt: FROZEN },
      ],
      daysToEarnings: 10, sourceUrls: [],
    },
  },
  {
    name: 'politician-only aggregate (no insider, no options)',
    agg: {
      ticker: 'POLONLY',
      trades: [], options: [],
      politicianTrades: [
        { politician: 'Rep Three', chamber: 'House', party: 'Democrat', ticker: 'POLONLY', transactionType: 'buy', amountMidpoint: 32_500, tradeDate: daysBefore(20), disclosureDate: daysBefore(5), daysToDisclose: 15, scrapedAt: FROZEN },
      ],
      sourceUrls: [],
    },
  },
  {
    name: 'strong track record + deep undervaluation',
    agg: {
      ticker: 'CTX',
      trades: [{ ticker: 'CTX', insiderName: 'Kim K', role: 'Chief Executive Officer', transactionType: 'P - Purchase', tradeDate: daysBefore(0), shares: 20_000, price: 50, value: 1_000_000, source: 'openinsider' }],
      options: [], bestAccuracy3m: 0.82, upsidePct: 55, marketCap: 8e8, sourceUrls: [],
    },
  },
];
