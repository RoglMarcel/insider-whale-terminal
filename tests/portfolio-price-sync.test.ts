import { DEFAULT_PORTFOLIO_CONFIG } from '../src/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  coverage: vi.fn(), fetch: vi.fn(), upsert: vi.fn(),
  config: vi.fn(), equity: vi.fn(), positions: vi.fn(), book: vi.fn(),
}));
vi.mock('../electron/database', () => ({
  getPriceCoverage: mocks.coverage,
  upsertPriceRows: mocks.upsert,
  getPortfolioConfig: mocks.config,
  getPortfolioRunMeta: () => null,
  getPortfolioExperiment: () => null,
  getPortfolioEquity: mocks.equity,
  getPortfolioPositions: mocks.positions,
  getPortfolioEvents: () => [],
  getPriceBook: mocks.book,
  getPriceAsOf: () => '2026-09-21',

}));
vi.mock('../electron/prices', () => ({
  PRICE_REQUEST_GAP_MS: 0,
  fetchAdjCloseSeries: mocks.fetch,
  screenSeries: (points: unknown[]) => ({ clean: points, suspect: [] }),
  sleep: async () => {},
}));
import { getPortfolioState, syncPrices } from '../electron/portfolio';

describe('portfolio price synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T20:00:00Z'));
    mocks.coverage.mockReturnValue({
      SPY: { last: '2026-09-11', fetchedAt: '2026-09-11T20:00:00Z' },
      AAA: { last: '2026-09-11', fetchedAt: '2026-09-11T20:00:00Z' },
    });
  });
  afterEach(() => vi.useRealTimers());

  it('refreshes holdings against freshly fetched SPY, not the old database date', async () => {
    mocks.fetch.mockImplementation(async (ticker: string) => [
      { date: '2026-09-21', px: ticker === 'SPY' ? 500 : 100 },
    ]);
    await syncPrices(['AAA', 'SPY'], '2026-09-01');
    expect(mocks.fetch.mock.calls.map((call) => call[0])).toEqual(['SPY', 'AAA']);
    expect(mocks.upsert).toHaveBeenCalledWith([{ ticker: 'AAA', date: '2026-09-21', adjClose: 100 }]);
  });

  it('reports a holding fetch failure without deleting cached prices', async () => {
    mocks.fetch.mockImplementation(async (ticker: string) => ticker === 'SPY'
      ? [{ date: '2026-09-21', px: 500 }] : null);
    const result = await syncPrices(['SPY', 'AAA'], '2026-09-01');
    expect(result.missing).toEqual(['AAA']);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });
});

it('shows the last known close, not the historical high, when today has no quote', () => {
  mocks.config.mockReturnValue(DEFAULT_PORTFOLIO_CONFIG);
  mocks.equity.mockReturnValue([{
    date: '2026-09-21', equity: 9900, cash: 9000, positionsValue: 900,
    spyCashValue: 0, equityIdle: 9900, benchmark: 10000, openPositions: 1,
  }]);
  mocks.positions.mockReturnValue([{
    id: 1, ticker: 'AAA', signalId: null, entryDate: '2026-09-01', entryPrice: 100,
    shares: 10, costBasis: 1000, entryScore: 70, targetWeight: 0.1,
    highWaterClose: 120, exitDate: null, exitPrice: null, exitReason: null,
    realizedPnl: null, spyEntry: 500, spyExit: null,
  }]);
  mocks.book.mockReturnValue({ AAA: {
    '2026-09-01': 100, '2026-09-10': 120, '2026-09-11': 90,
    '2026-09-22': 200, // Future prices must never enter today's mark.
  } });
  const state = getPortfolioState();
  expect(state.open[0]).toMatchObject({
    lastPrice: 90, priceAsOf: '2026-09-11', priceStale: true,
    marketValue: 900, nearestBarrier: null,
  });
  expect(state.open[0].unrealizedPct).toBeCloseTo(-0.1);
});
