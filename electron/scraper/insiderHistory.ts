import { requireHistoryUrl } from '../securityBoundary';
import { checkCancelled } from './cancellation';
import { scopedFetch } from './cancellation';
import type { BrowserContext } from 'playwright';
import type { InsiderTrackRecord, InsiderHistoricalTrade } from '../../src/types';
import { classifyTransaction, classifyInsiderPattern } from '../../src/types';
import { withPage } from './browser';
import { extractTable, colIndex, cell, parseMoney, parseShares, parseDate, cleanTicker, cleanText, yahooTicker } from './util';

/**
 * Feature 6 — scrape an insider's OpenInsider history page and compute a track
 * record. For each purchase we pull the ticker's SPLIT/DIVIDEND-ADJUSTED daily
 * series from Yahoo (adjClose) and measure the post-trade outcome at ~3 months
 * (90 calendar days) and ~6 months (180 days) IN EXCESS of the S&P 500 over the
 * same window (alpha) — so "profitable" means "beat the market", not merely "up
 * in a rising tide". Trades too recent to have an outcome yet are excluded.
 *
 * Caveat (survivorship bias): a buy on a ticker that was later delisted returns
 * no Yahoo history and is dropped, so win rates skew optimistic. Surfaced in the UI.
 */
const YF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Percent change from `basis` to `later`; undefined if either is missing or zero. */
function pctChange(later: number | undefined, basis: number | undefined): number | undefined {
  if (later == null || basis == null || basis === 0) return undefined;
  return ((later - basis) / basis) * 100;
}

/** Only adjusted prices are comparable across corporate actions. */
export function buildAdjCloseMap(result: any): Record<string, number> {
  const map: Record<string, number> = {};
  const timestamps = result?.timestamp || [];
  const adj = result?.indicators?.adjclose?.[0]?.adjclose || [];
  timestamps.forEach((ts: number, i: number) => {
    const v = adj[i];
    if (Number.isFinite(ts) && ts > 0 && ts * 1000 <= Date.now() && v != null && Number.isFinite(v) && v > 0) map[new Date(ts * 1000).toISOString().slice(0, 10)] = v;
  });
  return map;
}

// Per-ticker adjusted-close maps cached across insiders: insiders in the same
// sector overlap heavily, and re-downloading 10y of history per insider was
// the main drain on the pre-warm budget (and a Yahoo 429 trigger). Bounded LRU.
const tickerHistoryCache = new Map<string, { at: number; map: Record<string, number> }>();
const TICKER_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const TICKER_HISTORY_CACHE_MAX = 300;

// Benchmark (S&P 500 via SPY total-return) cached briefly so pre-warming many
// insiders in one scrape reuses a single fetch.
let benchmarkCache: { at: number; map: Record<string, number> } | null = null;
export async function getBenchmarkMap(): Promise<Record<string, number>> {
  if (benchmarkCache && Date.now() - benchmarkCache.at < 6 * 60 * 60 * 1000) return benchmarkCache.map;
  let map: Record<string, number> = {};
  try {
    const res = await scopedFetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=10y', {
      headers: { 'User-Agent': YF_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) map = buildAdjCloseMap((await res.json() as any)?.chart?.result?.[0]);
  } catch (e) {
    console.error('Failed to fetch S&P 500 benchmark history:', e);
  }
  checkCancelled();
  if (!Object.keys(map).length) throw new Error('Adjusted benchmark prices unavailable; retry later.');
  benchmarkCache = { at: Date.now(), map };
  return map;
}

function emptyRecord(name: string, role?: string): InsiderTrackRecord {
  return {
    insiderName: name,
    insiderRole: role ?? null,
    totalTrades: 0,
    profitable3m: 0,
    profitable6m: 0,
    accuracy3m: 0,
    accuracy6m: 0,
    avgReturn3m: 0,
    recentTrades: [],
    pattern: null,
    lastUpdated: new Date().toISOString(),
  };
}

export async function fetchInsiderTrackRecord(
  context: BrowserContext,
  name: string,
  insiderUrl?: string,
  role?: string,
): Promise<InsiderTrackRecord> {
  if (!insiderUrl) {
    return { ...emptyRecord(name, role), error: 'No history page available for this insider.' };
  }

  try {
    const table = await withPage(
      context,
      requireHistoryUrl(insiderUrl),
      async (page) => {
        await page.waitForSelector('table.tinytable', { timeout: 12_000 }).catch(() => undefined);
        return extractTable(page, 'table.tinytable');
      },
      { waitUntil: 'domcontentloaded', timeout: 25_000, validateNavigation: requireHistoryUrl },
    );

    const { headers, rows } = table;
    const idx = {
      tradeDate: colIndex(headers, ['trade date']),
      ticker: colIndex(headers, ['ticker', 'symbol']),
      type: colIndex(headers, ['trade type', 'transaction']),
      price: colIndex(headers, ['price']),
      qty: colIndex(headers, ['qty', 'quantity', 'shares']),
      value: colIndex(headers, ['value']),
    };

    // Group rows by ticker to fetch historical prices from Yahoo Finance
    const uniqueTickers = new Set<string>();
    for (const row of rows) {
      const typeStr = cleanText(cell(row, idx.type));
      if (classifyTransaction(typeStr).modifier <= 0) continue;
      const ticker = cleanTicker(cell(row, idx.ticker));
      if (ticker) uniqueTickers.add(ticker);
    }

    const tickerPriceMaps: Record<string, Record<string, number>> = {};
    let missingPriceCoverage = false;
    const benchmarkMap = await getBenchmarkMap();

    for (const ticker of uniqueTickers) {
      const cached = tickerHistoryCache.get(ticker);
      if (cached && Date.now() - cached.at < TICKER_HISTORY_TTL_MS) {
        tickerPriceMaps[ticker] = cached.map;
        continue;
      }
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker(ticker) || ticker)}?interval=1d&range=10y`;
        const res = await scopedFetch(url, { headers: { 'User-Agent': YF_UA }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`Adjusted ticker prices HTTP ${res.status}`);
        if (res.ok) {
          const result = (await res.json() as any)?.chart?.result?.[0];
          if (!result) throw new Error('Adjusted ticker prices missing');
          // Split/dividend-adjusted series so corporate actions don't masquerade as returns.
          if (result) {
            const map = buildAdjCloseMap(result);
            if (!Object.keys(map).length) throw new Error('Adjusted ticker prices unavailable');
            tickerPriceMaps[ticker] = map;
            checkCancelled();
            tickerHistoryCache.set(ticker, { at: Date.now(), map });
            // Evict oldest entries (Map preserves insertion order) to bound memory.
            while (tickerHistoryCache.size > TICKER_HISTORY_CACHE_MAX) {
              const oldest = tickerHistoryCache.keys().next().value;
              if (oldest == null) break;
              tickerHistoryCache.delete(oldest);
            }
          }
        }
      } catch (e) {
        missingPriceCoverage = true;
        checkCancelled();
        console.error(`Failed to fetch Yahoo history for ${ticker}:`, e);
      }
    }

    /** Walk calendar days in pure UTC so US timezones don't shift YYYY-MM-DD keys. */
    function getPriceNear(priceMap: Record<string, number> | undefined, dateStr: string, offsetDays = 0): number | undefined {
      if (!priceMap || !dateStr) return undefined;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
      if (!m) return undefined;
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offsetDays));
      if (Number.isNaN(d.getTime())) return undefined;
      // If in the future, return undefined (no outcome data yet)
      const todayUtc = new Date();
      const todayStart = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
      if (d.getTime() > todayStart) return undefined;

      // Try up to 5 days forward to find a trading day
      for (let i = 0; i < 5; i++) {
        const searchDate = d.toISOString().slice(0, 10);
        if (priceMap[searchDate] != null) {
          return priceMap[searchDate];
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return undefined;
    }

    const history: InsiderHistoricalTrade[] = [];
    // ALL purchase dates (even rows without a usable price/outcome) — the
    // calendar-pattern classifier needs the full buying habit, not just the
    // trades that have measurable returns.
    const allPurchaseDates: string[] = [];
    for (const row of rows) {
      const typeStr = cleanText(cell(row, idx.type));
      if (classifyTransaction(typeStr).modifier <= 0) continue; // purchases only

      const ticker = cleanTicker(cell(row, idx.ticker));
      const tradeDate = parseDate(cell(row, idx.tradeDate));
      const purchasePrice = parseMoney(cell(row, idx.price)) || undefined;
      const shares = parseShares(cell(row, idx.qty)) || undefined;
      const value = Math.abs(parseMoney(cell(row, idx.value))) || undefined;

      if (ticker && tradeDate) allPurchaseDates.push(tradeDate);
      if (!ticker || !tradeDate || !purchasePrice) continue;

      const priceMap = tickerPriceMaps[ticker];
      // Adjusted price AT the trade date is the only valid basis: later prices
      // are split/dividend-adjusted, so comparing them against the raw fill
      // price would let corporate actions masquerade as returns. No adjusted
      // basis (trade older than the fetched range) → no comparable outcome.
      const basis = getPriceNear(priceMap, tradeDate, 0);
      if (basis == null) continue;
      const price3mLater = getPriceNear(priceMap, tradeDate, 90);
      const price6mLater = getPriceNear(priceMap, tradeDate, 180);

      // Benchmark (S&P) return over the same window → subtract for alpha. A
      // missing benchmark window means NO outcome — silently defaulting it to 0
      // would mislabel the raw return as "vs S&P" whenever the SPY fetch fails.
      const mktBasis = getPriceNear(benchmarkMap, tradeDate, 0);
      const mkt3 = pctChange(getPriceNear(benchmarkMap, tradeDate, 90), mktBasis);
      const mkt6 = pctChange(getPriceNear(benchmarkMap, tradeDate, 180), mktBasis);

      const abs3 = pctChange(price3mLater, basis);
      const abs6 = pctChange(price6mLater, basis);
      const r3 = abs3 != null && mkt3 != null ? abs3 - mkt3 : undefined;
      const r6 = abs6 != null && mkt6 != null ? abs6 - mkt6 : undefined;

      if (r3 == null && r6 == null) continue; // no outcome data yet

      history.push({
        tradeDate,
        ticker,
        transactionType: typeStr,
        shares,
        value,
        purchasePrice,
        price3mLater,
        price6mLater,
        return3m: r3 != null ? Math.round(r3 * 10) / 10 : undefined,
        wasProfitable3m: r3 != null ? r3 > 0 : undefined,
        wasProfitable6m: r6 != null ? r6 > 0 : undefined,
      });
    }

    const with3m = history.filter((h) => h.return3m != null);
    const with6m = history.filter((h) => h.wasProfitable6m != null);
    const totalTrades = with3m.length;
    const profitable3m = with3m.filter((h) => h.wasProfitable3m).length;
    // 6-month accuracy must be measured over trades that actually have a 6-month
    // outcome — not the (larger) set of trades with a 3-month outcome, which would
    // systematically understate it for any insider with recent activity.
    const profitable6m = with6m.filter((h) => h.wasProfitable6m).length;
    const avgReturn3m =
      totalTrades > 0 ? with3m.reduce((s, h) => s + (h.return3m ?? 0), 0) / totalTrades : 0;

    if (totalTrades === 0 || missingPriceCoverage) {
      return {
        ...emptyRecord(name, role),
        pattern: classifyInsiderPattern(allPurchaseDates),
        error: missingPriceCoverage ? 'Adjusted price coverage incomplete; retry later.' : 'No post-trade performance data yet.',
      };
    }

    // Most recent 8 outcomes, ordered oldest → newest for the sparkline.
    const recentTrades = [...with3m]
      .sort((a, b) => (Date.parse(b.tradeDate) || 0) - (Date.parse(a.tradeDate) || 0))
      .slice(0, 8)
      .reverse();

    return {
      insiderName: name,
      insiderRole: role ?? null,
      totalTrades,
      profitable3m,
      profitable6m,
      accuracy3m: profitable3m / totalTrades,
      accuracy6m: with6m.length > 0 ? profitable6m / with6m.length : 0,
      avgReturn3m: Math.round(avgReturn3m * 10) / 10,
      recentTrades,
      pattern: classifyInsiderPattern(allPurchaseDates),
      lastUpdated: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ...emptyRecord(name, role),
      error: err instanceof Error ? err.message : 'Track record unavailable',
    };
  }
}
