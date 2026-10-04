import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeAnalysisTicker } from '../src/types/analysis';
import { calculateFairValue } from '../electron/fairValue';

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });
describe('independent stock analysis', () => {
  it('normalizes tickers and rejects URLs and malformed inputs', () => {
    expect(normalizeAnalysisTicker(' $aapl ')).toBe('AAPL');
    expect(normalizeAnalysisTicker('brk.b')).toBe('BRK.B');
    for (const input of [null, 42, '', 'http://localhost', '../secrets', 'AAPL?t=MSFT', 'a'.repeat(50)]) {
      expect(() => normalizeAnalysisTicker(input)).toThrow();
    }
  });
  it('analyzes a stock without any alert database and shares in-flight work', async () => {
    const fetcher = await import('../electron/scraper/fairValue');
    const value = calculateFairValue({ eps: { value: 3, source: 'https://example.com', fetchedAt: new Date().toISOString() } });
    let finish!: (payload: typeof value) => void;
    const mock = vi.spyOn(fetcher, 'fetchFairValue').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { analyzeStock } = await import('../electron/analysis');
    const first = analyzeStock('TEST');
    const second = analyzeStock('test');
    finish(value);
    const [a, b] = await Promise.all([first, second]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.origin).toBe('live');
    expect(a.ticker).toBe('TEST');
    expect(await analyzeStock('TEST')).toEqual(a);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('does not request providers for invalid symbols', async () => {
    const fetcher = await import('../electron/scraper/fairValue');
    const mock = vi.spyOn(fetcher, 'fetchFairValue');
    const { analyzeStock } = await import('../electron/analysis');
    await expect(analyzeStock('../private')).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });
});
