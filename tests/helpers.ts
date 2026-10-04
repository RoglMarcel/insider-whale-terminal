import type { RawInsiderTrade, OptionsActivity, PoliticianTrade, TickerAggregate } from '../src/types';

/** UTC calendar date N days ago — `daysBetween` anchors date-only strings to UTC midnight. */
export function ymd(daysAgo = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The smallest step below a threshold that still reads as "just under" it. */
export const EPS = 1e-9;

export function trade(over: Partial<RawInsiderTrade> = {}): RawInsiderTrade {
  return {
    ticker: 'TEST',
    insiderName: 'Jane Doe',
    role: 'Chief Executive Officer',
    transactionType: 'P - Purchase',
    tradeDate: ymd(0),
    shares: 1000,
    price: 10,
    value: 10_000,
    source: 'openinsider',
    ...over,
  };
}

export function option(over: Partial<OptionsActivity> = {}): OptionsActivity {
  return {
    ticker: 'TEST',
    type: 'call',
    sentiment: 'bullish',
    notional: 600_000,
    premiumTotal: 600_000,
    source: 'barchart',
    ...over,
  };
}

export function politician(over: Partial<PoliticianTrade> = {}): PoliticianTrade {
  return {
    politician: 'A Member',
    chamber: 'House',
    party: 'Democrat',
    ticker: 'TEST',
    transactionType: 'buy',
    amountMidpoint: 750_000,
    tradeDate: ymd(0),
    disclosureDate: ymd(0),
    daysToDisclose: 5,
    scrapedAt: new Date().toISOString(),
    ...over,
  };
}

export function aggregate(over: Partial<TickerAggregate> = {}): TickerAggregate {
  return { ticker: 'TEST', trades: [], options: [], sourceUrls: [], ...over };
}

/** Deep structural clone, so a test can prove a function did not mutate its input. */
export function snapshot<T>(v: T): string {
  return JSON.stringify(v);
}
