import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAdjCloseSeries, outcomeCutoff, outcomePricePair } from '../electron/prices';
const payload = { chart: { result: [{ timestamp: [1790294400], indicators: { adjclose: [{ adjclose: [100] }] } }] } };
const ok = () => ({ ok: true, json: async () => payload });
const fail = (status: number) => ({ ok: false, status });
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('adjusted price request recovery', () => {
  it('fetches the verified current symbol for CYBN without altering the requested identity', async () => {
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
    const fetcher = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchAdjCloseSeries('CYBN')).not.toBeNull();
    expect(fetcher.mock.calls[0][0]).toContain('/chart/HELP?');
  });
  it('never sends quarantined text to the price provider', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await fetchAdjCloseSeries('NVDAEARNINGS')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('recovers a throttled primary host through the secondary host', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const pending = fetchAdjCloseSeries('BRK.B');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([{ date: '2026-09-25', px: 100 }]);
    expect(fetcher.mock.calls[0][0]).toContain('query1.finance.yahoo.com/v8/finance/chart/BRK-B');
    expect(fetcher.mock.calls[1][0]).toContain('query2.finance.yahoo.com');
  });
  it('keeps retries bounded and returns missing data on persistent failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const pending = fetchAdjCloseSeries('AAA');
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('AAA: network error or timeout'));
  });
  it('does not retry a nonexistent ticker', async () => {
    const fetcher = vi.fn().mockResolvedValue(fail(404));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchAdjCloseSeries('GONE')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never replaces missing adjusted closes with raw closes', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ chart: { result: [{ timestamp: [1790294400], indicators: { quote: [{ close: [100] }] } }] } }) });
    vi.stubGlobal('fetch', fetcher);
    const pending = fetchAdjCloseSeries('AAA');
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
  });
  it('respects cancellation without another request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(); controller.abort();
    expect(await fetchAdjCloseSeries('AAA', { signal: controller.signal })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('outcome trading-calendar cutoff', () => {
  it('does not compare different sessions when an equity has a historical gap', () => {
    const spy = [{ date: '2026-09-21', px: 100 }, { date: '2026-09-22', px: 101 }];
    const equity = [{ date: '2026-09-22', px: 10 }];
    expect(outcomePricePair(equity, spy, '2026-09-19')).toBeNull();
    expect(outcomePricePair(equity, spy, '2026-09-22')).toEqual({ equity: equity[0], benchmark: spy[1] });
  });
  it('keeps Saturday and Sunday outcomes pending until the next benchmark session', () => {
    const prices = [{ date: '2026-09-25', px: 100 }];
    expect(outcomeCutoff(prices, '2026-09-26')).toBe('2026-09-25');
    expect(outcomeCutoff(prices, '2026-09-27')).toBe('2026-09-25');
    expect(outcomeCutoff([...prices, { date: '2026-09-28', px: 101 }], '2026-09-28')).toBe('2026-09-28');
  });
  it('uses observed sessions across holidays and rejects future/invalid points', () => {
    expect(outcomeCutoff([{ date: '2026-09-04', px: 100 }, { date: '2026-09-08', px: 101 }], '2026-09-07')).toBe('2026-09-04');
    expect(outcomeCutoff([{ date: '2026-09-25', px: NaN }], '2026-09-26')).toBeNull();
  });
});
