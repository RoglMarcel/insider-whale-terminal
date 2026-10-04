import { checkCancelled, cancellableDelay } from './cancellation';
import { scopedFetch } from './cancellation';
import { XMLParser } from 'fast-xml-parser';
import type { FilingEvent } from '../../src/types';
import { cleanText, isValidTicker, canonicalTicker } from './util';
import { getCikTickerMap } from './sellside';

/**
 * SC 13D / 13G radar — 5%+ stake disclosures from EDGAR's "current events"
 * Atom feeds (13D = activist intent; 13G = passive large holder; /A =
 * amendment). Each filing appears once per associated party: the SUBJECT
 * entry's CIK resolves to the ticker via company_tickers.json, and the
 * "Filed by" entry supplies the fund/person name. Plain fetch, no browser.
 */

const SEC_UA = 'insider-whale-terminal/1.0 (marcel.rogls@gmail.com)';
const FEEDS = [
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13D&company=&dateb=&owner=include&count=100&output=atom',
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13G&company=&dateb=&owner=include&count=100&output=atom',
];

const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

interface AtomEntry {
  title?: unknown;
  updated?: unknown;
  link?: { '@_href'?: string };
}

/** Parse one getcurrent Atom document into filing events (pure — testable offline). */
export function parseActivistAtom(atomText: string, cikMap: ReadonlyMap<number, string>): FilingEvent[] {
  const doc = xml.parse(atomText);
  const entries = asArray<AtomEntry>(doc?.feed?.entry);

  // Group the per-party entries of each filing by accession number.
  interface Group {
    type: string;
    ticker?: string;
    filer?: string;
    date?: string;
    url?: string;
  }
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const title = typeof entry.title === 'string' ? entry.title : '';
    const m = /^(SC 13[DG](?:\/A)?)\s*-\s*(.+?)\s*\((\d{10})\)\s*\(([^)]+)\)\s*$/.exec(title.trim());
    if (!m) continue;
    const [, type, name, cikStr, partyRole] = m;
    const href = entry.link?.['@_href'] ?? '';
    // Accession appears dashed or dash-less depending on the page — normalize
    // so the SUBJECT and FILED-BY entries of one filing group together.
    const accRaw = /(\d{10}-?\d{2}-?\d{6})/.exec(href)?.[1];
    const acc = accRaw ? accRaw.replace(/-/g, '') : '';
    if (!acc) continue;
    const g = groups.get(acc) ?? { type };
    const role = partyRole.toLowerCase();
    if (role.includes('subject')) {
      const ticker = cikMap.get(Number(cikStr));
      if (isValidTicker(ticker)) g.ticker = canonicalTicker(ticker);
    } else if (role.includes('filed by') || role.includes('filer')) {
      g.filer = cleanText(name);
      // The filer might ALSO be a listed company (corporate raider) — only
      // use its CIK for the ticker if no subject entry resolves.
    }
    const updated = typeof entry.updated === 'string' ? entry.updated : '';
    if (/^\d{4}-\d{2}-\d{2}/.test(updated)) g.date = updated.slice(0, 10);
    if (href && !g.url) g.url = href;
    groups.set(acc, g);
  }

  const out: FilingEvent[] = [];
  for (const g of groups.values()) {
    if (!g.ticker || !g.date) continue;
    out.push({ ticker: g.ticker, type: g.type, filer: g.filer ?? null, filedDate: g.date, url: g.url ?? '' });
  }
  return out;
}

export async function fetchActivistFilings(reportIssue: (message: string) => void = console.warn): Promise<FilingEvent[]> {
  const cikMap = await getCikTickerMap();
  if (cikMap.size === 0) return [];

  const out: FilingEvent[] = [];
  let completed = 0;
  for (const feed of FEEDS) {
    try {
      const res = await scopedFetch(feed, { headers: { 'User-Agent': SEC_UA }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (!/<feed[\s>]/.test(body)) throw new Error('Invalid activist Atom feed');
      out.push(...parseActivistAtom(body, cikMap));
      completed++;
    } catch (error) {
      checkCancelled();
      reportIssue(`Activist coverage incomplete: ${error instanceof Error ? error.message : String(error)}`);
    }
    await cancellableDelay(300); // SEC pacing between feeds
  }
  if (!completed) throw new Error('All activist feeds failed');
  return out;
}
