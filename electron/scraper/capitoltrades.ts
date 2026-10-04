import { cancellableDelay, checkCancelled } from './cancellation';
import { scopedFetch } from './cancellation';
import { utcDateMs } from '../../src/lib/utcDate';
import { parseQuiverData } from './quiverData';
import type { BrowserContext } from 'playwright';
import type { PoliticianTrade } from '../../src/types';
import { withPage } from './browser';
import { isValidTicker, canonicalTicker } from './util';

/**
 * Capitol Trades — congressional (House + Senate) STOCK Act disclosures.
 *
 * Layer 1: public BFF JSON (bff.capitoltrades.com).
 * Layer 2: Playwright on capitoltrades.com (intercept BFF responses + table parse).
 * Layer 3 is handled by senatewatcher / house mirrors + Quiver HTML embed
 * (see scrapeCongressChain in the orchestrator).
 */

const BFF_URL = 'https://bff.capitoltrades.com/trades';
const PAGE_URL = 'https://www.capitoltrades.com/trades';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 96;
const MAX_PAGES = 10;
const REQUEST_GAP_MS = 2000;
const MAX_RETRIES = 3;

const sleep = cancellableDelay;

// ── Amount range → midpoint ──

const RANGE_MIDPOINTS: ReadonlyArray<{ lo: number; hi: number; mid: number }> = [
  { lo: 1_001, hi: 15_000, mid: 8_000 },
  { lo: 15_001, hi: 50_000, mid: 32_500 },
  { lo: 50_001, hi: 100_000, mid: 75_000 },
  { lo: 100_001, hi: 250_000, mid: 175_000 },
  { lo: 250_001, hi: 500_000, mid: 375_000 },
  { lo: 500_001, hi: 1_000_000, mid: 750_000 },
];
const OVER_MILLION_MID = 1_250_000;

/** Map a disclosed amount to its midpoint from an explicit low/high or a label. */
export function amountToMidpoint(low?: number, high?: number, label?: string): number {
  if (typeof low === 'number' && typeof high === 'number' && high > 0) {
    if (low >= 1_000_000 && (!high || high <= low)) return OVER_MILLION_MID;
    const match = RANGE_MIDPOINTS.find((r) => Math.abs(r.lo - low) <= 2 || (low >= r.lo - 1 && high <= r.hi + 1));
    if (match) return match.mid;
    if (low >= 1_000_000) return OVER_MILLION_MID;
    return Math.round((low + high) / 2);
  }
  const s = (label ?? '').replace(/[$,\s]/g, '').toLowerCase();
  if (!s) return 0;
  if (/>1?,?000,?000|>1m|1m\+|over1000000/.test(s)) return OVER_MILLION_MID;
  const nums = s.match(/\d[\d]*/g)?.map(Number) ?? [];
  if (nums.length >= 2) return amountToMidpoint(nums[0], nums[1]);
  if (nums.length === 1) {
    if (nums[0] >= 1_000_000) return OVER_MILLION_MID;
    const r = RANGE_MIDPOINTS.find((x) => nums[0] >= x.lo - 1 && nums[0] <= x.hi + 1);
    return r ? r.mid : nums[0];
  }
  return 0;
}

export function normalizeChamber(raw: unknown): 'House' | 'Senate' | null {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('senate') || s === 's' || s.includes('senator')) return 'Senate';
  if (s.includes('house') || s === 'h' || s.includes('rep')) return 'House';
  return null;
}

export function normalizeParty(raw: unknown): string {
  const s = String(raw ?? '').toLowerCase();
  if (s.startsWith('d') || s.includes('democrat')) return 'Democrat';
  if (s.startsWith('r') || s.includes('republican')) return 'Republican';
  if (s.startsWith('i') || s.includes('independent')) return 'Independent';
  return raw ? String(raw) : '';
}

export function normalizeTxType(raw: unknown): 'buy' | 'sell' | null {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('buy') || s.includes('purchase') || s === 'p') return 'buy';
  if (s.includes('sell') || s.includes('sale') || s === 's') return 'sell';
  return null;
}

export function toYmd(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(text);
  if (iso) return utcDateMs(iso[1]) !== null ? iso[1] : '';
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (!us) return '';
  const year = us[3].length === 2 ? `20${us[3]}` : us[3];
  const date = `${year}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return utcDateMs(date) !== null ? date : '';
}

/**
 * Capitol Trades writes symbols as `AAPL:US`, so the exchange suffix is stripped
 * before the shared rules apply. Returns '' when the cell is not a symbol at all
 * — the feed also carries bond and fund rows whose "ticker" is a description
 * ("3 Month Maturity", "GLAS Funds", "TE1"), and those used to become signals.
 */
export function cleanTicker(raw: unknown): string {
  const base = String(raw ?? '').toUpperCase().split(':')[0].trim();
  return isValidTicker(base) ? canonicalTicker(base) : '';
}

function daysBetweenYmd(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// ── BFF JSON shapes ──

interface BffPolitician {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  chamber?: string;
  party?: string;
  committees?: string[];
}
interface BffTrade {
  politician?: BffPolitician;
  politicianName?: string;
  chamber?: string;
  party?: string;
  committees?: string[];
  issuerTicker?: string;
  ticker?: string;
  asset?: { assetTicker?: string; issuerTicker?: string };
  txType?: string;
  type?: string;
  value?: number;
  size?: string;
  sizeRangeLow?: number;
  sizeRangeHigh?: number;
  txDate?: string;
  tradeDate?: string;
  pubDate?: string;
  filingDate?: string;
  reportingGap?: number;
}
interface BffResponse {
  data?: BffTrade[];
  meta?: { paging?: { page?: number; totalPages?: number } };
}

export function mapBffTrade(t: BffTrade, scrapedAt: string): PoliticianTrade | null {
  const pol = t.politician ?? {};
  const name =
    pol.fullName ||
    t.politicianName ||
    [pol.firstName, pol.lastName].filter(Boolean).join(' ').trim();
  if (!name) return null;

  const chamber = normalizeChamber(pol.chamber ?? t.chamber);
  if (!chamber) return null;

  const ticker = cleanTicker(t.issuerTicker ?? t.ticker ?? t.asset?.assetTicker ?? t.asset?.issuerTicker);
  if (!ticker) return null;

  const txType = normalizeTxType(t.txType ?? t.type);
  if (!txType) return null;

  const tradeDate = toYmd(t.txDate ?? t.tradeDate);
  const disclosureDate = toYmd(t.pubDate ?? t.filingDate);


  const amountMidpoint = amountToMidpoint(t.sizeRangeLow, t.sizeRangeHigh, t.size ?? (t.value ? String(t.value) : ''));
  if (!(amountMidpoint > 0)) return null;

  const committees = pol.committees ?? t.committees ?? [];
  const committee = Array.isArray(committees) && committees.length ? String(committees[0]) : undefined;

  const daysToDisclose =
    typeof t.reportingGap === 'number' && t.reportingGap >= 0
      ? t.reportingGap
      : daysBetweenYmd(tradeDate, disclosureDate);

  return {
    politician: name,
    chamber,
    party: normalizeParty(pol.party ?? t.party),
    committee,
    ticker,
    transactionType: txType,
    amountMidpoint,
    tradeDate,
    disclosureDate,
    daysToDisclose,
    scrapedAt,
  };
}

function dedupeTrades(trades: PoliticianTrade[]): PoliticianTrade[] {
  const seen = new Set<string>();
  const out: PoliticianTrade[] = [];
  for (const t of trades) {
    const key = `${t.politician}|${t.ticker}|${t.tradeDate}|${t.transactionType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

async function fetchPage(page: number, lookbackDays: number): Promise<BffResponse | null> {
  const url = `${BFF_URL}?txDate=${lookbackDays}d&pageSize=${PAGE_SIZE}&page=${page}&sortBy=-txDate`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await scopedFetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://www.capitoltrades.com',
          Referer: 'https://www.capitoltrades.com/trades',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return (await res.json()) as BffResponse;
      // 429/503 retry; other 4xx give up this page
      if (res.status !== 429 && res.status !== 503 && res.status < 500) return null;
    } catch {
      /* network/timeout → retry */
    }
    if (attempt < MAX_RETRIES) await sleep(1000 * Math.pow(2, attempt));
  }
  return null;
}

/**
 * Layer 1 — Capitol Trades BFF JSON API.
 * Throws if the first page cannot be fetched at all (hard failure for the layer).
 */
export async function scrapeCapitolTradesApi(lookbackDays = 90, reportIssue: (message: string) => void = console.warn): Promise<PoliticianTrade[]> {
  const scrapedAt = new Date().toISOString();
  const out: PoliticianTrade[] = [];
  const seen = new Set<string>();
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  // Warm the origin (some edges require a prior HTML hit before BFF answers).
  try {
    await scopedFetch(PAGE_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* optional warm-up */
  }
  await sleep(500);

  for (let page = 1; page <= MAX_PAGES; page++) {
    checkCancelled();
    const json = await fetchPage(page, lookbackDays);
    if (!json) {
      if (page === 1) throw new Error('Capitol Trades BFF unavailable (no page-1 response after retries)');
      reportIssue(`Capitol Trades incomplete: page ${page} unavailable`);
      break;
    }
    if (!Array.isArray(json.data)) throw new Error('Capitol Trades response has no trade array');
    const rows = json.data;
    if (rows.length === 0) break;

    let anyInWindow = false;
    let allOlderThanCutoff = true;
    for (const raw of rows) {
      const trade = mapBffTrade(raw, scrapedAt);
      if (!trade) continue;
      if (!trade.tradeDate || trade.tradeDate >= cutoff) {
        allOlderThanCutoff = false;
        anyInWindow = true;
        const key = `${trade.politician}|${trade.ticker}|${trade.tradeDate}|${trade.transactionType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trade);
      }
    }

    const totalPages = json.meta?.paging?.totalPages ?? MAX_PAGES;
    if (page >= totalPages) break;
    if (page === MAX_PAGES && !allOlderThanCutoff) reportIssue(`Capitol Trades truncated at ${MAX_PAGES}/${totalPages} pages`);
    if (allOlderThanCutoff && !anyInWindow) break;
    await sleep(REQUEST_GAP_MS);
  }

  return out;
}

/** @deprecated use scrapeCapitolTradesApi / scrapeCongressChain */
export async function scrapeCapitolTrades(lookbackDays = 90): Promise<PoliticianTrade[]> {
  try {
    return await scrapeCapitolTradesApi(lookbackDays);
  } catch {
    return [];
  }
}

/**
 * Layer 2 — Playwright: open the public trades page, capture BFF JSON from
 * network responses, fall back to reading any rendered table rows.
 */
export async function scrapeCapitolTradesPlaywright(
  context: BrowserContext,
  lookbackDays = 90,
): Promise<PoliticianTrade[]> {
  const scrapedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const collected: PoliticianTrade[] = [];

  await withPage(
    context,
    PAGE_URL,
    async (page) => {
      const onResponse = async (res: { url: () => string; status: () => number; json: () => Promise<unknown> }) => {
        try {
          const u = res.url();
          if (!u.includes('capitoltrades.com') || !u.includes('trade')) return;
          if (res.status() !== 200) return;
          if (!u.includes('bff.') && !u.includes('/trades')) return;
          const json = (await res.json()) as BffResponse;
          const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? (json as BffTrade[]) : [];
          for (const raw of rows) {
            const trade = mapBffTrade(raw as BffTrade, scrapedAt);
            if (!trade || trade.tradeDate < cutoff) continue;
            collected.push(trade);
          }
        } catch {
          /* ignore non-JSON */
        }
      };
      page.on('response', onResponse);

      await page.waitForTimeout(2500);
      // Scroll to encourage pagination / lazy loads
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(800);
      }

      // DOM fallback: any table-like rows with ticker-ish text
      if (collected.length === 0) {
        try {
          const rows = await page.evaluate(() => {
            const out: string[][] = [];
            document.querySelectorAll('table tbody tr, [role="row"]').forEach((tr) => {
              const cells = Array.from(tr.querySelectorAll('td, [role="cell"]')).map((c) =>
                (c.textContent || '').replace(/\s+/g, ' ').trim(),
              );
              if (cells.length >= 4) out.push(cells);
            });
            return out;
          });
          for (const cells of rows) {
            // Best-effort: find a ticker token and buy/sell + money range
            const joined = cells.join(' | ');
            const tick = cleanTicker(cells.find((c) => /^[A-Z]{1,5}(:[A-Z]+)?$/.test(c)) ?? '');
            if (!tick) continue;
            const txType = normalizeTxType(joined);
            if (!txType) continue;
            const amt = amountToMidpoint(undefined, undefined, joined.match(/\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?/)?.[0]);
            if (!(amt > 0)) continue;
            const dateCell = cells.find((c) => /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c));
            const tradeDate = ''; // Unlabelled DOM dates cannot establish execution time.

            const name = cells.find((c) => /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(c) && !c.includes('$')) ?? 'Unknown';
            const chamber = normalizeChamber(joined) ?? 'House';
            collected.push({
              politician: name,
              chamber,
              party: normalizeParty(joined),
              ticker: tick,
              transactionType: txType,
              amountMidpoint: amt,
              tradeDate,
              disclosureDate: '',
              daysToDisclose: null,
              scrapedAt,
            });
          }
        } catch {
          /* DOM optional */
        }
      }

      page.off('response', onResponse);
    },
    { waitUntil: 'domcontentloaded', timeout: 45_000 },
  ).catch((err) => {
    throw new Error(`Capitol Trades Playwright scrape failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  const deduped = dedupeTrades(collected);
  if (deduped.length === 0) {
    throw new Error('Capitol Trades Playwright: page loaded but no trades parsed from network or DOM');
  }
  return deduped;
}

/**
 * Quiver Quantitative public congress page embeds `recentTradesData` as a JS
 * array in the HTML (current House+Senate). Pure fetch — no Playwright.
 */
export async function scrapeQuiverCongressEmbed(lookbackDays = 90): Promise<PoliticianTrade[]> {
  const res = await scopedFetch('https://www.quiverquant.com/congresstrading/', {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Quiver congress page HTTP ${res.status}`);
  const html = await res.text();
  const rows = parseQuiverData(html);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Quiver congress page: empty recentTradesData');
  }

  const scrapedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const out: PoliticianTrade[] = [];

  // Row shape (verified live 2026-07):
  // [ticker, company, assetClass, tx, amount, politician, chamber, party, filed, traded, desc, id, ...]
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 10) continue;
    const ticker = cleanTicker(row[0]);
    if (!ticker) continue;
    const txType = normalizeTxType(row[3]);
    if (!txType) continue;
    const amountMidpoint = amountToMidpoint(undefined, undefined, String(row[4] ?? ''));
    if (!(amountMidpoint > 0)) continue;
    const politician = String(row[5] ?? '').trim();
    if (!politician) continue;
    const chamber = normalizeChamber(row[6]);
    if (!chamber) continue;
    const disclosureDate = toYmd(row[8]);
    const tradeDate = toYmd(row[9]);
    if (tradeDate && tradeDate < cutoff) continue;

    out.push({
      politician,
      chamber,
      party: normalizeParty(row[7]),
      ticker,
      transactionType: txType,
      amountMidpoint,
      tradeDate,
      disclosureDate,
      daysToDisclose: daysBetweenYmd(tradeDate, disclosureDate),
      scrapedAt,
    });
  }

  const deduped = dedupeTrades(out);
  if (deduped.length === 0) throw new Error('Quiver congress page: no trades within lookback window');
  return deduped;
}
