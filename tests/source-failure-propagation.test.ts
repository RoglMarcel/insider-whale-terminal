import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { scrapeQuiverQuant } from '../electron/scraper/quiverquant';
import { scrapeBarchart } from '../electron/scraper/barchart';
import { extractFirstTable } from '../electron/scraper/util';
afterEach(() => vi.restoreAllMocks());
it('propagates navigation failures from insider and options collectors', async () => {
  const context={newPage:vi.fn().mockRejectedValue(new Error('navigation failed'))} as unknown as BrowserContext;
  await expect(scrapeQuiverQuant(context)).rejects.toThrow('navigation failed');
  await expect(scrapeBarchart(context)).rejects.toThrow('navigation failed');
});
it('distinguishes missing tables from recognized empty tables', async () => {
  const missing={evaluate:vi.fn().mockResolvedValue({headers:[],rows:[]})} as unknown as Page;
  await expect(extractFirstTable(missing,['table'])).rejects.toThrow('missing or unreadable');
  const empty={evaluate:vi.fn().mockResolvedValue({headers:['Ticker','Date'],rows:[]})} as unknown as Page;
  expect((await extractFirstTable(empty,['table'])).rows).toEqual([]);
});
