import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequestPacer, retryTransient, SourceHttpError } from '../electron/scraper/reliability';
import { parseAtomFilings, scrapeEdgar } from '../electron/scraper/edgar';
import type { BrowserContext } from 'playwright';

const feed = (n: number) => `<feed>${Array.from({ length: n }, (_, i) => `<entry><category label="form type" term="4"/><link href="https://www.sec.gov/Archives/edgar/data/1/0000000001-26-00000${i}-index.htm"/><updated>2026-09-22</updated></entry>`).join('')}</feed>`;
const ownership = (code: string) => `<ownershipDocument><issuer><issuerTradingSymbol>ABC</issuerTradingSymbol></issuer><nonDerivativeTable><nonDerivativeTransaction><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionDate><value>2026-09-21</value></transactionDate><transactionAmounts><transactionShares><value>10</value></transactionShares><transactionPricePerShare><value>20</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
const context = {} as BrowserContext;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded source recovery', () => {
  it('spaces concurrent request starts', async () => {
    const pace = createRequestPacer(300);
    const times: number[] = [];
    const work = Promise.all(Array.from({ length: 6 }, async () => { await pace(); times.push(Date.now()); }));
    await vi.runAllTimersAsync();
    await work;
    expect(times.slice(1).every((t, i) => t - times[i] >= 300)).toBe(true);
  });

  it('retries one temporary failure and honors Retry-After', async () => {
    const run = vi.fn().mockRejectedValueOnce(new SourceHttpError(503, '3')).mockResolvedValue('ok');
    const result = retryTransient(run);
    await vi.advanceTimersByTimeAsync(2999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([new SourceHttpError(403), new SourceHttpError(404), new SourceHttpError(429, '600'), new Error('Invalid table')])('does not retry permanent failures or shorten long cooldowns: %s', async (error) => {
    const run = vi.fn().mockRejectedValue(error);
    await expect(retryTransient(run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops after the second network failure', async () => {
    const run = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const result = expect(retryTransient(run)).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await result;
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('EDGAR coverage', () => {
  it('rejects an HTML block page but accepts a genuinely empty Atom feed', () => {
    expect(() => parseAtomFilings('<html>Access denied</html>')).toThrow('invalid Atom');
    expect(parseAtomFilings('<feed/>')).toEqual([]);
  });

  it('excludes prefix matches before deduplication and accepts Form 4 amendments', () => {
    const purchase = feed(1);
    const unrelated = purchase.replace('term="4"', 'term="424B2"').replace('<feed>', '').replace('</feed>', '');
    expect(parseAtomFilings(purchase.replace('<feed>', '<feed>' + unrelated))).toHaveLength(1);
    expect(parseAtomFilings(purchase.replace('term="4"', 'term="4/A"'))).toHaveLength(1);
    expect(parseAtomFilings(purchase.replace('term="4"', 'term="40-F"'))).toEqual([]);
  });

  it('supports the Atom title as a form-type fallback', () => {
    expect(parseAtomFilings(feed(1).replace('<category label="form type" term="4"/>', '<title>4 - Example (Issuer)</title>'))).toHaveLength(1);
  });

  it('reports a failed feed as a failure, not zero purchases', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(scrapeEdgar(context)).rejects.toThrow('HTTP 403');
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps purchases when another filing fails and reports incomplete coverage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('browse-edgar')) return new Response(feed(2));
      if (url.includes('000000000126000001')) return new Response('missing', { status: 404 });
      if (url.endsWith('index.json')) return Response.json({ directory: { item: [{ name: 'metadata.xml' }, { name: 'form4.xml' }] } });
      if (url.endsWith('metadata.xml')) return new Response('<metadata/>');
      return new Response(ownership('P'));
    }));
    const report = vi.fn();
    const result = scrapeEdgar(context, report);
    await vi.runAllTimersAsync();
    expect((await result).map((r) => r.ticker)).toEqual(['ABC']);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('1/2 filings read, 1 failed'));
  });

  it('does not call valid sale-only filings a broken source', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('browse-edgar')) return new Response(feed(1));
      if (url.endsWith('index.json')) return Response.json({ directory: { item: [{ name: 'form4.xml' }] } });
      return new Response(ownership('S'));
    }));
    const report = vi.fn();
    const result = scrapeEdgar(context, report);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([]);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('bounded'));
    expect(report).not.toHaveBeenCalledWith(expect.stringContaining('failed'));
  });
});

it('retains a precise source publication instant but does not invent one for date-only feeds', () => {
  expect(parseAtomFilings(feed(1))[0].revisionAt).toBeUndefined();
  expect(parseAtomFilings(feed(1).replace('2026-09-22','2026-09-22T15:00:00-04:00'))[0].revisionAt).toBe('2026-09-22T15:00:00-04:00');
});
