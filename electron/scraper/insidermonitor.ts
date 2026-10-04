import type { BrowserContext } from 'playwright';
import type { RawInsiderTrade } from '../../src/types';
import { withPage } from './browser';
import { extractFirstTable, colIndex, cell, parseMoney, parseShares, parseDate, cleanTicker, cleanText, sanitizeTradeAmounts, isValidTicker, canonicalTicker } from './util';

/**
 * Insider-Monitor — daily SEC Form 4 purchase digest. Static HTML, public, no
 * login; an independent cross-check alongside the primary sources. Quirks
 * handled here: grouped rows (follow-up trades by the same insider leave the
 * Symbol/Company cells blank → inherit from the row above), a merged
 * "Shares & Price" cell ("104,650 $7.45"), and B/AB/S/AS trade-type codes
 * (AB/AS = pre-scheduled 10b5-1 "automatic" trades). The digest carries no
 * insider title — when EDGAR/OpenInsider report the same filing they win the
 * dedup and supply the role.
 */
const URL = 'http://www.insider-monitor.com/insider_stock_purchases.html';

function mapTradeType(code: string): string {
  const c = code.trim().toUpperCase();
  if (c === 'AB') return '10b5-1 Purchase';
  if (c === 'AS') return '10b5-1 Sale';
  if (c.startsWith('S')) return 'S - Sale';
  if (c.startsWith('B')) return 'P - Purchase';
  // An UNKNOWN code is not a purchase. Returning 'P - Purchase' here gave every
  // unrecognized code a full-weight open-market buy — the assumption
  // classifyTransaction explicitly refuses to make. Pass it through so the
  // shared classifier can decide (and land on Unknown / modifier 0).
  return c;
}

export async function scrapeInsiderMonitor(context: BrowserContext): Promise<RawInsiderTrade[]> {
  return withPage(
    context,
    URL,
    async (page) => {
      await page.waitForSelector('table', { timeout: 10_000 });
      const table = await extractFirstTable(page, ['table']);
      const idx = {
        ticker: colIndex(table.headers, ['symbol', 'ticker']),
        company: colIndex(table.headers, ['company']),
        insider: colIndex(table.headers, ['insider name', 'insider']),
        type: colIndex(table.headers, ['trade type', 'type']),
        sharesPrice: colIndex(table.headers, ['shares']),
        value: colIndex(table.headers, ['value']),
        date: colIndex(table.headers, ['trade date', 'date']),
      };

      const out: RawInsiderTrade[] = [];
      let lastTicker = '';
      let lastCompany = '';
      for (const row of table.rows) {
        let ticker = cleanTicker(cell(row, idx.ticker));
        // (validated below, after the grouped-row inheritance)
        let company = cleanText(cell(row, idx.company));
        // Grouped layout: continuation rows for the same insider leave the
        // symbol/company cells blank (&nbsp;) — inherit from the row above.
        if (ticker) {
          lastTicker = ticker;
          lastCompany = company;
        } else {
          ticker = lastTicker;
          company = company || lastCompany;
        }
        if (!ticker) continue;

        const insiderName = cleanText(cell(row, idx.insider)) || 'Unknown';
        const tradeDate = parseDate(cell(row, idx.date));
        if (!tradeDate) continue;

        // Merged "Shares & Price" cell, e.g. "104,650 $7.45".
        // Require a $ before the price token so a lone "40,000,000" is shares-only
        // (not misread as price=$40,000,000 when the value column is also large).
        const sp = cleanText(cell(row, idx.sharesPrice));
        const spMatch = /^([\d,]+(?:\.\d+)?)\s*(?:\$\s*([\d.,]+))?/.exec(sp);
        const shares = spMatch ? parseShares(spMatch[1]) : 0;
        const price = spMatch?.[2] ? parseMoney(spMatch[2]) : undefined;
        let value = Math.abs(parseMoney(cell(row, idx.value)));
        if (!value && shares && price) value = shares * price;
        const sane = sanitizeTradeAmounts(shares, price, value);
        if (!sane) continue;

        out.push({
          ticker,
          companyName: company || undefined,
          insiderName,
          role: '', // no title column on this digest
          transactionType: mapTradeType(cell(row, idx.type)),
          tradeDate,
          shares: sane.shares,
          price: sane.price,
          value: sane.value,
          source: 'insidermonitor',
          sourceUrl: URL,
        });
      }
      if (!out.length) throw new Error('Insider Monitor purchase table missing or unreadable');
      return out;
    },
    { waitUntil: 'domcontentloaded', timeout: 20_000, reliable: true },
  );
}
