import type { BrowserContext } from 'playwright';
import type { RawInsiderTrade } from '../../src/types';
import { withPage, randomDelay } from './browser';
import { extractFirstTable, colIndex, cell, parseMoney, parseShares, parseDate, cleanText, sanitizeTradeAmounts, isValidTicker, canonicalTicker } from './util';

/**
 * Start of a job title glued directly onto a surname. Anchored on the known
 * title vocabulary (not on a lowercase→uppercase transition) so real names that
 * contain an internal capital are left alone.
 */
const TITLE_BOUNDARY =
  /(?:Chief|President|Vice[ ]?President|Director|Chairman|Chairwoman|Chair|Executive|Senior|General[ ]Counsel|General[ ]Partner|Managing|Officer|Treasurer|Secretary|Founder|Co-?Founder|Owner|Partner|Principal|Head[ ]of|Trustee|Controller|EVP|SVP|AVP|VP|CEO|CFO|COO|CTO|CMO|CIO|10%)/;

/**
 * Split Quiver's "Name / Title" cell. Pure and exported so both renderings can
 * be regression-tested without a browser.
 */
export function splitNameTitle(raw: string, dash = raw.lastIndexOf('-')): { insiderName: string; role: string } {
  let insiderName = (dash >= 0 ? raw.slice(0, dash) : raw).trim() || 'Unknown';
  let role = dash >= 0 ? raw.slice(dash + 1).trim() : '';
  // Quiver also renders the name and the title as two sibling nodes with no
  // separator between them, so `textContent` yields "Genner Gareth NevilleChief
  // Executive Officer" with no dash to split on. Recover the boundary from the
  // title vocabulary rather than from a lowercase->uppercase transition, which
  // would wreck names like "McDonald" or "DeAngelo".
  if (!role) {
    const m = TITLE_BOUNDARY.exec(insiderName);
    if (m && m.index > 0) {
      role = insiderName.slice(m.index).trim();
      insiderName = insiderName.slice(0, m.index).trim() || 'Unknown';
    }
  }
  return { insiderName, role };
}

/**
 * Quiver Quantitative — live insider feed. Client-rendered table (verified to
 * populate under headless Playwright) carrying insider names AND titles, both
 * purchases and sales, and near-real-time "Disclosed" timestamps. Values are
 * estimates ("Value (Est.)"), so glitched rows are dropped by sanity caps, and
 * exact per-filing sources (EDGAR/OpenInsider) win the dedup whenever they
 * report the same trade.
 */
const URL = 'https://www.quiverquant.com/insiders/';

export async function scrapeQuiverQuant(context: BrowserContext): Promise<RawInsiderTrade[]> {
  return withPage(
    context,
    URL,
    async (page) => {
      await page.waitForSelector('table tbody tr', { timeout: 20_000 }).catch(() => undefined);
      await randomDelay(1500, 2500);
      const table = await extractFirstTable(page, ['table']);
      const idx = {
        nameTitle: colIndex(table.headers, ['name / title', 'name/title', 'name']),
        ticker: colIndex(table.headers, ['stock', 'ticker', 'symbol']),
        type: colIndex(table.headers, ['purchase / sale', 'purchase/sale', 'transaction', 'type']),
        value: colIndex(table.headers, ['value']),
        shares: colIndex(table.headers, ['shares']),
        price: colIndex(table.headers, ['share price', 'price']),
        date: colIndex(table.headers, ['date']),
        disclosed: colIndex(table.headers, ['disclosed']),
      };

      const out: RawInsiderTrade[] = [];
      for (const row of table.rows) {
        // Quiver renders a bare dash for rows without a resolvable symbol; one
        // such row carried a $6,000,000 trade into the database as ticker "-".
        const rawTicker = cell(row, idx.ticker);
        if (!isValidTicker(rawTicker)) continue;
        const ticker = canonicalTicker(rawTicker);

        // "Name / Title" renders as "Surname Firstname-Title", with a trailing
        // dash and empty title for institutional filers — split at the LAST
        // dash so hyphenated surnames survive.
        const raw = cleanText(cell(row, idx.nameTitle));
        const dash = raw.lastIndexOf('-');
        const { insiderName, role } = splitNameTitle(raw, dash);

        const typeRaw = cleanText(cell(row, idx.type)).toLowerCase();
        let transactionType: string;
        if (typeRaw.includes('purchase') || typeRaw.includes('buy')) transactionType = 'P - Purchase';
        else if (typeRaw.includes('sale') || typeRaw.includes('sell')) transactionType = 'S - Sale';
        else continue; // unknown direction — do not guess

        const tradeDate = parseDate(cell(row, idx.date));
        if (!tradeDate) continue;
        // "Jul 02, 2026 (09:49 PM)" — strip the parenthetical time first.
        const filingDate = parseDate(cleanText(cell(row, idx.disclosed)).replace(/\(.*\)/, '')) || undefined;

        const shares = parseShares(cell(row, idx.shares));
        const price = parseMoney(cell(row, idx.price)) || undefined;
        let value = Math.abs(parseMoney(cell(row, idx.value)));
        if (!value && shares && price) value = shares * price;
        const sane = sanitizeTradeAmounts(shares, price, value);
        if (!sane) continue;

        out.push({
          ticker,
          insiderName,
          role,
          transactionType,
          tradeDate,
          filingDate,
          shares: sane.shares,
          price: sane.price,
          value: sane.value,
          source: 'quiverquant',
          sourceUrl: URL,
        });
      }
      return out;
    },
    { waitUntil: 'domcontentloaded' },
  );
}
