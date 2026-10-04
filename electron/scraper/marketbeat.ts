import type { BrowserContext } from 'playwright';
import type { RawInsiderTrade } from '../../src/types';
import { withPage } from './browser';
import { extractFirstTable } from './util';
import { mapInsiderTable } from './insiderMap';

/**
 * MarketBeat insider trades summary. The ticker is usually embedded in the
 * company cell, e.g. "Apple Inc. (NASDAQ:AAPL)" — mapInsiderTable extracts it.
 */
const URL = 'https://www.marketbeat.com/insider-trades/';

const TABLE_SELECTORS = [
  'table.scroll-table',
  '#cphPrimaryContent_pnlContent table',
  'table.indicators',
  'table',
];

export async function scrapeMarketBeat(context: BrowserContext): Promise<RawInsiderTrade[]> {
  return withPage(
    context,
    URL,
    async (page) => {
      await page.waitForSelector('table', { timeout: 15_000 }).catch(() => undefined);
      const table = await extractFirstTable(page, TABLE_SELECTORS);
      return mapInsiderTable(table, 'marketbeat', URL);
    },
    { waitUntil: 'domcontentloaded' },
  );
}
