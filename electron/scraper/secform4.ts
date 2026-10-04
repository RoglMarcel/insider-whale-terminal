import { useScrapling, scraplingTable } from './scrapling';
import type { BrowserContext } from 'playwright';
import type { RawInsiderTrade } from '../../src/types';
import { withPage } from './browser';
import { extractFirstTable } from './util';
import { mapInsiderTable } from './insiderMap';

/**
 * SECForm4 — additional Form 4 data. Layout is loosely structured, so we use
 * the generic table extractor and fuzzy header mapping. Best-effort.
 */
const URL = 'https://www.secform4.com/all-buys';

const TABLE_SELECTORS = ['table.tablesorter', 'table.insiders', 'table[width]', 'table'];

export async function scrapeSecForm4(context: BrowserContext): Promise<RawInsiderTrade[]> {
  if (useScrapling()) {
    const data = await scraplingTable(URL, TABLE_SELECTORS);
    const trades = mapInsiderTable({headers:data.headers,rows:data.rows.map(r=>r.cells)}, 'secform4', URL);
    if (!trades.length) throw new Error('SECForm4 purchase table missing or unreadable');
    return trades;
  }
  return withPage(
    context,
    URL,
    async (page) => {
      await page.waitForSelector('table', { timeout: 10_000 });
      const table = await extractFirstTable(page, TABLE_SELECTORS);
      const trades = mapInsiderTable(table, 'secform4', URL);
      if (!trades.length) throw new Error('SECForm4 purchase table missing or unreadable');
      return trades;
    },
    { waitUntil: 'domcontentloaded', timeout: 20_000, reliable: true },
  );
}
