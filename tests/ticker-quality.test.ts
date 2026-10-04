import { describe, expect, it } from 'vitest';
import { cleanPortfolioCandidates, resolvedTicker, tickerIssue } from '../src/lib/ticker-quality';
import { simulatePortfolio } from '../src/lib/portfolio-rules';
import { DEFAULT_PORTFOLIO_CONFIG, type PortfolioCandidate } from '../src/types';

describe('conservative ticker cleanup', () => {
  it.each(['-', '3.MONTHMATURE', 'GLASFUNDS', 'NVDAEARNINGS', ''])('quarantines malformed feed value %s', (ticker) => {
    expect(tickerIssue(ticker)).not.toBeNull();
  });
  it.each(['AAXIA', 'AVB', 'BOTA', 'GREE', 'BRK.B', 'BRK-B', 'TE1', 'RKMIX'])('does not infer bad data from missing prices for %s', (ticker) => {
    expect(tickerIssue(ticker)).toBeNull();
  });
  it('uses the verified rename only on or after its effective date', () => {
    expect(resolvedTicker('CYBN', '2026-01-02')).toBe('CYBN');
    expect(resolvedTicker('CYBN', '2026-01-05')).toBe('HELP');
    expect(resolvedTicker('AAXIA', '2026-09-26')).toBe('AAXIA');
  });
  it('prevents separate positions for two names of the same security, retaining source candidates', () => {
    const rows: PortfolioCandidate[] = ['CYBN', 'HELP', '-'].map((ticker) => ({ ticker, earliestDate: '2026-09-01', score: 80, signalId: null, source: 'signal' }));
    const candidates = cleanPortfolioCandidates(rows);
    const sim = simulatePortfolio({ config: DEFAULT_PORTFOLIO_CONFIG, candidates,
      tradingDays: ['2026-09-01', '2026-09-02'], spy: { '2026-09-01': 100, '2026-09-02': 100 },
      prices: { HELP: { '2026-09-01': 10, '2026-09-02': 10 } } });
    expect(sim.positions).toHaveLength(1);
    expect(sim.positions[0].ticker).toBe('HELP');
    expect(rows.map((r) => r.ticker)).toEqual(['CYBN', 'HELP', '-']);
  });
});
