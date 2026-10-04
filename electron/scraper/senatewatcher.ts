import { cancellableDelay, checkCancelled } from './cancellation';
import { scopedFetch } from './cancellation';
import type { PoliticianTrade } from '../../src/types';
import {
  amountToMidpoint,
  normalizeParty,
  normalizeTxType,
  toYmd,
} from './capitoltrades';
import { isValidTicker, canonicalTicker } from './util';

/**
 * STOCK Act mirrors — House + Senate public dumps (GitHub / jsDelivr).
 * Used as the last fallback when Capitol Trades API + Playwright fail.
 *
 * Note: the original S3 buckets often return 403; GitHub/jsDelivr mirrors are
 * preferred. Senate aggregate on some mirrors can lag; House data is typically
 * more current.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_RETRIES = 3;
const RECENT_DAYS = 120;

const SENATE_URLS = [
  'https://cdn.jsdelivr.net/gh/timothycarambat/senate-stock-watcher-data@master/aggregate/all_transactions.json',
  'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json',
  'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
];

const HOUSE_URLS = [
  'https://raw.githubusercontent.com/TattooedHead/house-stock-watcher-data/main/data/all_transactions.json',
  'https://cdn.jsdelivr.net/gh/TattooedHead/house-stock-watcher-data@main/data/all_transactions.json',
  'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
];

const sleep = cancellableDelay;

interface WatcherTxn {
  transaction_date?: string;
  disclosure_date?: string;
  ticker?: string;
  type?: string;
  amount?: string;
  amount_mid?: number;
  senator?: string;
  representative?: string;
  party?: string;
  owner?: string;
}

function daysBetweenYmd(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

async function fetchJsonArray(urls: string[]): Promise<WatcherTxn[]> {
  let lastErr = 'no URLs';
  for (const url of urls) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await scopedFetch(url, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(45_000),
        });
        if (res.ok) {
          const json = (await res.json()) as unknown;
          if (Array.isArray(json) && json.length) return json as WatcherTxn[];
          lastErr = `${url}: empty array`;
          break;
        }
        lastErr = `${url}: HTTP ${res.status}`;
        if (res.status !== 429 && res.status !== 503 && res.status < 500) break;
      } catch (e) {
        lastErr = `${url}: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (attempt < MAX_RETRIES) await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw new Error(`STOCK Act watcher dumps unavailable (${lastErr})`);
}

function mapWatcherRows(
  rows: WatcherTxn[],
  chamber: 'House' | 'Senate',
  scrapedAt: string,
  cutoff: string,
): PoliticianTrade[] {
  const out: PoliticianTrade[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    // The ad-hoc sentinel list here is now the shared rule in util.ts.
    if (!isValidTicker(r.ticker)) continue;
    const ticker = canonicalTicker(r.ticker);
    const txType = normalizeTxType(r.type);
    if (!txType) continue;
    const tradeDate = toYmd(r.transaction_date);
    if (tradeDate && tradeDate < cutoff) continue;
    const disclosureDate = toYmd(r.disclosure_date);
    const amountMidpoint =
      typeof r.amount_mid === 'number' && r.amount_mid > 0
        ? r.amount_mid
        : amountToMidpoint(undefined, undefined, r.amount);
    if (!(amountMidpoint > 0)) continue;
    const politician = String(chamber === 'Senate' ? r.senator ?? '' : r.representative ?? r.senator ?? '').trim();
    if (!politician) continue;

    const key = `${politician}|${ticker}|${tradeDate}|${txType}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      politician,
      chamber,
      party: normalizeParty(r.party),
      committee: undefined,
      ticker,
      transactionType: txType,
      amountMidpoint,
      tradeDate,
      disclosureDate,
      daysToDisclose: daysBetweenYmd(tradeDate, disclosureDate),
      scrapedAt,
    });
  }
  return out;
}

/**
 * Layer 3 — House + Senate public dumps. Throws if both chambers yield nothing.
 * Prefer GitHub/jsDelivr mirrors; S3 is tried last (often 403).
 */
export async function scrapeCongressWatchers(reportIssue: (message: string) => void = console.warn): Promise<PoliticianTrade[]> {
  const scrapedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const errors: string[] = [];
  let out: PoliticianTrade[] = [];

  try {
    const house = await fetchJsonArray(HOUSE_URLS);
    out = out.concat(mapWatcherRows(house, 'House', scrapedAt, cutoff));
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const senate = await fetchJsonArray(SENATE_URLS);
    out = out.concat(mapWatcherRows(senate, 'Senate', scrapedAt, cutoff));
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  checkCancelled();
  for (const error of errors) reportIssue(`Congress chamber coverage incomplete: ${error}`);
  if (out.length === 0) {
    throw new Error(`Congress watcher dumps produced 0 trades (${errors.join(' | ') || 'unknown'})`);
  }
  return out;
}

/** @deprecated — use scrapeCongressWatchers */
export async function scrapeSenateWatcher(): Promise<PoliticianTrade[]> {
  try {
    return await scrapeCongressWatchers();
  } catch {
    return [];
  }
}
