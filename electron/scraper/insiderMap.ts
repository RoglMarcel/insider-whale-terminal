import type { RawInsiderTrade, ScraperSource } from '../../src/types';
import {
  type ExtractedTable,
  colIndex,
  cell,
  parseMoney,
  parseShares,
  parseDate,
  cleanTicker,
  cleanText,
  sanitizeTradeAmounts,
  isValidTicker,
  canonicalTicker,
} from './util';

/** Pull a ticker out of text like "Apple Inc. (NASDAQ:AAPL)" or "(AAPL)". */
export function extractTickerFromText(text: string): string {
  if (!text) return '';
  const m1 = text.match(/(?:NASDAQ|NYSE(?:\s*AMERICAN)?|AMEX|OTC|CBOE|BATS|ARCA)\s*[:.]?\s*([A-Z.]{1,6})/i);
  if (m1) return cleanTicker(m1[1]);
  const m2 = text.match(/\(([A-Z.]{1,6})\)/);
  if (m2) return cleanTicker(m2[1]);
  return '';
}

/**
 * Map a generic insider-trade HTML table into normalized RawInsiderTrade[].
 * Columns are matched by fuzzy header alias, so this handles the slightly
 * different layouts of openinsider / finviz / secform4 / marketbeat.
 */
export function mapInsiderTable(
  table: ExtractedTable,
  source: ScraperSource,
  url: string,
): RawInsiderTrade[] {
  const { headers, rows } = table;
  const idx = {
    ticker: colIndex(headers, ['ticker', 'symbol', 'stock']),
    company: colIndex(headers, ['company name', 'company', 'name']),
    insider: colIndex(headers, ['insider name', 'insider', 'owner', 'reporting', 'name of']),
    title: colIndex(headers, ['title', 'relationship', 'relation', 'position', 'role']),
    type: colIndex(headers, ['trade type', 'buy/sell', 'transaction', 'acquired', 'type']),
    tradeDate: colIndex(headers, ['trade date', 'transaction date', 'date']),
    filingDate: colIndex(headers, ['filing date', 'file date', 'filed', 'reported']),
    qty: colIndex(headers, ['qty', 'quantity', '# shares', 'shares', '# of shares', 'number of shares']),
    price: colIndex(headers, ['price', 'avg price', 'average price']),
    value: colIndex(headers, ['value', 'total value', 'total transaction', 'amount', 'total', 'cost']),
  };

  const out: RawInsiderTrade[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowUrl = table.rowUrls?.[i] || url;
    let companyCell = cleanText(cell(row, idx.company));
    let ticker = cleanTicker(cell(row, idx.ticker));
    let insiderName = cleanText(cell(row, idx.insider)) || 'Unknown';
    let role = cleanText(cell(row, idx.title));
    // NOT defaulted to 'P'. `extractFirstTable` falls back to "any table on the
    // page", so a renamed header column made `idx.type` = −1 and EVERY row was
    // then scored as a full-weight open-market purchase — the exact assumption
    // classifyTransaction documents it will never make. An empty type now stays
    // empty and classifies as Unknown (modifier 0).
    let transactionType = cleanText(cell(row, idx.type));
    let tradeDateVal = cell(row, idx.tradeDate);

    // SECForm4 special parsing for merged cells
    if (source === 'secform4') {
      const dateCell = cell(row, idx.tradeDate);
      const dateParts = dateCell.split('\n').map(s => s.trim()).filter(Boolean);
      tradeDateVal = dateParts[0] || '';
      const typePart = dateParts[1] || '';
      // Pass the raw type text through — binarizing everything non-sale to 'P'
      // scored grants/exercises as full-strength open-market buys; the shared
      // classifyTransaction handles the descriptive strings correctly. An empty
      // cell stays empty (Unknown), it is not assumed to be a purchase.
      transactionType = typePart;

      const insiderCell = cell(row, idx.insider);
      const insiderParts = insiderCell.split('\n').map(s => s.trim()).filter(Boolean);
      insiderName = insiderParts[0] || 'Unknown';
      role = insiderParts.slice(1).join(' ');
    }

    // MarketBeat special parsing for merged cells
    if (source === 'marketbeat') {
      const compCell = cell(row, idx.company);
      const compParts = compCell.split('\n').map(s => s.trim()).filter(Boolean);
      if (compParts.length > 1) {
        ticker = cleanTicker(compParts[0]);
        companyCell = compParts.slice(1).join(' ');
      }

      const insiderCell = cell(row, idx.insider);
      const insiderParts = insiderCell.split('\n').map(s => s.trim()).filter(Boolean);
      insiderName = insiderParts[0] || 'Unknown';
      role = insiderParts.slice(1).join(' ');
    }

    if (!ticker) ticker = extractTickerFromText(companyCell);
    // Shape gate. Without it, sentinel and label cells became "tickers": a bare
    // dash from Quiver carried a $6M trade, and Finviz's doubled-first-letter
    // rendering produced DDGICA / GGLIBA / LLILAK alongside the real symbols.
    if (!isValidTicker(ticker)) continue;
    ticker = canonicalTicker(ticker);

    const shares = parseShares(cell(row, idx.qty));
    let price = parseMoney(cell(row, idx.price)) || undefined;
    let value = Math.abs(parseMoney(cell(row, idx.value)));
    if (!value && shares && price) {
      value = shares * price;
    } else if (value && shares && !price) {
      price = value / shares;
    }
    const sane = sanitizeTradeAmounts(shares, price, value);
    if (!sane) continue;

    out.push({
      ticker,
      companyName: companyCell || undefined,
      insiderName,
      role,
      transactionType,
      tradeDate: parseDate(tradeDateVal),
      filingDate: parseDate(cell(row, idx.filingDate)) || undefined,
      shares: sane.shares,
      price: sane.price,
      value: sane.value,
      source,
      sourceUrl: rowUrl,
    });
  }
  return out;
}
