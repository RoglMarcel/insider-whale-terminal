import { checkCancelled } from './cancellation';
import { scopedFetch } from './cancellation';
import type { BrowserContext } from 'playwright';
import { XMLParser } from 'fast-xml-parser';
import { withPage } from './browser';
import { extractFirstTable, colIndex, cell, parseMoney, parseDate, cleanText, isValidTicker, canonicalTicker } from './util';

/**
 * Sell-side intelligence — the buy-only pipeline's missing other half. Two
 * collectors feed the `insider_flow` table (context/display only; they never
 * produce signals and never block the signal pipeline):
 *
 *  1. OpenInsider SALES screener (xp=0&xs=1) — per-ticker daily insider sale
 *     dollar totals, same tinytable layout as the purchases screener.
 *  2. EDGAR Form 144 Atom feed — notices of PROPOSED sales (the leading
 *     indicator that a large insider sale is coming). The atom carries no
 *     ticker, so issuer CIKs are mapped through the SEC's company_tickers.json;
 *     individual sellers' CIKs simply don't resolve and drop out naturally.
 */

export interface InsiderFlowRow {
  ticker: string;
  flowDate: string; // YYYY-MM-DD
  buyValue: number;
  sellValue: number;
  form144Count: number;
  source: string;
}

export interface SalesSnapshot {
  rows: InsiderFlowRow[];
  complete: boolean;
  from: string;
  through: string;
  startedAt: string;
}

/** A bounded feed is not a replacement snapshot. Require two matching complete traversals. */
export async function scrapeOpenInsiderSales(context: BrowserContext, reportIssue: (message: string) => void = console.warn): Promise<SalesSnapshot> {
  const startedAt = new Date().toISOString();
  const through = startedAt.slice(0,10);
  const from = new Date(Date.now()-89*86_400_000).toISOString().slice(0,10);
  const base = 'http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=0&fdr=&td=90&tdr=&daysago=&xp=0&xs=1&vl=0&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=1&cnt=500';
  const scan = async () => {
    const rows: InsiderFlowRow[] = [];
    const pages = new Set<string>();
    const seenRows = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const result = await scrapeSalesPage(context, `${base}&page=${page}`);
      if (pages.has(result.signature)) throw new Error('Sales pagination repeated a page');
      pages.add(result.signature);
      for (const row of result.rawRows) {
        const key = JSON.stringify(row);
        if (seenRows.has(key)) throw new Error('Sales pagination contains overlapping rows');
        seenRows.add(key);
      }
      rows.push(...result.rows);
      if (result.count === 0) return { rows, signature: [...seenRows].sort().join('\n') };
    }
    throw new Error('Sales pagination reached its 10-page limit without a confirmed end');
  };
  const sum = (rows: InsiderFlowRow[]) => {
    const totals = new Map<string, InsiderFlowRow>();
    for (const row of rows) {
      if (row.flowDate < from || row.flowDate > through) continue;
      const key = `${row.ticker}|${row.flowDate}`;
      const previous = totals.get(key);
      totals.set(key, { ...row, sellValue: row.sellValue + (previous?.sellValue ?? 0) });
    }
    return [...totals.values()].sort((a,b) => `${a.ticker}|${a.flowDate}`.localeCompare(`${b.ticker}|${b.flowDate}`));
  };
  try {
    const first = await scan();
    const second = await scan();
    if (first.signature !== second.signature) throw new Error('Sales snapshot changed during pagination');
    return { rows: sum(second.rows), complete: true, from, through, startedAt };
  } catch (error) {
    reportIssue(`Sales coverage incomplete; keeping previous verified totals: ${error instanceof Error ? error.message : String(error)}`);
    return { rows: [], complete: false, from, through, startedAt };
  }
}

async function scrapeSalesPage(context: BrowserContext, url: string): Promise<{ rows: InsiderFlowRow[]; count: number; signature: string; rawRows: string[][] }> {
  return withPage(
    context,
    url,
    async (page) => {
      await page.waitForSelector('table.tinytable', { timeout: 15_000 }).catch(() => undefined);
      const table = await extractFirstTable(page, ['table.tinytable']);
      const idx = {
        ticker: colIndex(table.headers, ['ticker', 'symbol']),
        type: colIndex(table.headers, ['trade type', 'transaction']),
        date: colIndex(table.headers, ['trade date']),
        value: colIndex(table.headers, ['value']),
      };
      if (Object.values(idx).some(i => i < 0)) throw new Error('Sales columns missing');
      // Aggregate to one row per ticker per trade day.
      const byKey = new Map<string, number>();
      for (const row of table.rows) {
        const rawTicker = cell(row, idx.ticker);
        if (!isValidTicker(rawTicker)) throw new Error('Sales row has invalid ticker');
        const ticker = canonicalTicker(rawTicker);
        // The screener is asked for sales only, but guard anyway.
        const type = cleanText(cell(row, idx.type)).toLowerCase();
        if (!type || (!type.includes('sale') && !type.startsWith('s'))) throw new Error('Sales row has unrecognized transaction type');
        const flowDate = parseDate(cell(row, idx.date));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(flowDate)) throw new Error('Sales row has no valid trade date');
        const value = Math.abs(parseMoney(cell(row, idx.value)));
        if (!Number.isFinite(value) || !(value > 0)) throw new Error('Sales row has no positive value');
        const key = `${ticker}|${flowDate}`;
        byKey.set(key, (byKey.get(key) ?? 0) + value);
      }
      const out: InsiderFlowRow[] = [];
      for (const [key, sellValue] of byKey) {
        const [ticker, flowDate] = key.split('|');
        out.push({ ticker, flowDate, buyValue: 0, sellValue, form144Count: 0, source: 'openinsider-sales' });
      }
      return { rows: out, count: table.rows.length, signature: JSON.stringify(table.rows), rawRows: table.rows };
    },
    { waitUntil: 'domcontentloaded', reliable: true },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// EDGAR Form 144 — proposed-sale notices (metadata level; count per ticker/day)
// ──────────────────────────────────────────────────────────────────────────

const FORM144_ATOM =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=144&company=&dateb=&owner=include&count=100&output=atom';
const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA = 'insider-whale-terminal/1.0 (marcel.rogls@gmail.com)';

const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

// The CIK→ticker map is ~1MB and changes rarely — cache it for the session.
// The same file also carries each issuer's registered name (`title`), which is the
// only company-name source for options-only ("whale") tickers — those aggregates
// come from options scrapers that report no company name at all.
let cikTickerCache: { at: number; map: Map<number, string>; names: Map<string, string> } | null = null;
const CIK_MAP_TTL_MS = 24 * 60 * 60 * 1000;

async function loadSecTickerFile(): Promise<{ map: Map<number, string>; names: Map<string, string> }> {
  if (cikTickerCache && Date.now() - cikTickerCache.at < CIK_MAP_TTL_MS) return cikTickerCache;
  const map = new Map<number, string>();
  const names = new Map<string, string>();
  try {
    const res = await scopedFetch(TICKER_MAP_URL, {
      headers: { 'User-Agent': SEC_UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const json = (await res.json()) as Record<string, { cik_str?: number; ticker?: string; title?: string }>;
      for (const entry of Object.values(json)) {
        if (typeof entry?.cik_str === 'number' && typeof entry?.ticker === 'string' && !map.has(entry.cik_str)) {
          // First occurrence wins — the file is ordered so the primary share
          // class of a CIK comes first.
          map.set(entry.cik_str, entry.ticker.toUpperCase());
        }
        if (typeof entry?.ticker === 'string' && typeof entry?.title === 'string') {
          const t = entry.ticker.toUpperCase();
          const title = entry.title.trim();
          if (!names.has(t)) names.set(t, title);
          // Share classes: the SEC writes BRK-B, the scrapers normalize to BRK.B
          // (cleanTicker keeps both separators) — register the alias too.
          const alias = t.includes('-') ? t.replace(/-/g, '.') : t.includes('.') ? t.replace(/\./g, '-') : '';
          if (alias && !names.has(alias)) names.set(alias, title);
        }
      }
    }
  } catch {
    throw new Error('SEC ticker map unavailable');
  }
  if (!map.size) throw new Error('SEC ticker map empty or invalid');
  checkCancelled();
  if (map.size > 0) cikTickerCache = { at: Date.now(), map, names };
  return { map, names };
}

export async function getCikTickerMap(): Promise<Map<number, string>> {
  return (await loadSecTickerFile()).map;
}

/** TICKER → registered company name, from the SEC's company_tickers.json. */
export async function getTickerNameMap(): Promise<Map<string, string>> {
  return (await loadSecTickerFile()).names;
}

/**
 * Every symbol the SEC lists, in canonical (dot) form — the oracle behind
 * `repairDoubledTicker`. Empty when the file could not be fetched, which the
 * caller must treat as "do not repair anything".
 */
export async function getRegisteredTickers(): Promise<Set<string>> {
  const { names } = await loadSecTickerFile();
  const out = new Set<string>();
  for (const t of names.keys()) out.add(canonicalTicker(t));
  return out;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export async function fetchEdgarForm144(reportIssue: (message: string) => void = console.warn): Promise<InsiderFlowRow[]> {
  try {
    const cikMap = await getCikTickerMap();
    if (cikMap.size === 0) throw new Error('SEC issuer map unavailable');
    const res = await scopedFetch(FORM144_ATOM, {
      headers: { 'User-Agent': SEC_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SEC Form 144 HTTP ${res.status}`);
    const doc = xml.parse(await res.text());
    if (!doc?.feed) throw new Error('SEC Form 144 invalid feed');
    reportIssue('Form 144 is a bounded recent-feed observation, not complete 90-day coverage');
    const entries = asArray<Record<string, unknown>>(doc?.feed?.entry);

    // One filing appears once per associated party — dedupe by accession, and
    // resolve the ticker via whichever associated CIK is a listed issuer
    // (individual sellers' CIKs are not in company_tickers.json).
    const seenAccessions = new Set<string>();
    const byKey = new Map<string, number>();
    for (const entry of entries) {
      const title = typeof entry.title === 'string' ? entry.title : '';
      if (!/^144(?:\/A)?\s*-/.test(title.trim())) continue;
      const cikMatch = /\((\d{10})\)/.exec(title);
      if (!cikMatch) continue;
      const ticker = cikMap.get(Number(cikMatch[1]));
      if (!ticker) continue; // not an issuer CIK → the seller-side entry
      const link = entry.link as { '@_href'?: string } | undefined;
      const acc = /(\d{10}-\d{2}-\d{6})/.exec(link?.['@_href'] ?? '')?.[1] ?? '';
      const accKey = acc ? `${acc}` : `${title}`;
      if (seenAccessions.has(accKey)) continue;
      seenAccessions.add(accKey);
      const updated = typeof entry.updated === 'string' ? entry.updated : '';
      const flowDate = /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : '';
      if (!flowDate) continue;
      const key = `${canonicalTicker(ticker)}|${flowDate}`;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }

    const out: InsiderFlowRow[] = [];
    for (const [key, count] of byKey) {
      const [ticker, flowDate] = key.split('|');
      out.push({ ticker, flowDate, buyValue: 0, sellValue: 0, form144Count: count, source: 'edgar144' });
    }
    return out;
  } catch (error) {
    throw error;
  }
}
