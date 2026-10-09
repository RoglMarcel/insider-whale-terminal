import { withTimeout, checkCancelled } from './cancellation';
import { scopedFetch } from './cancellation';
import { dedupTrades } from '../tradeDedup';
export { dedupTrades } from '../tradeDedup';
import { tickerIssue, resolvedTicker } from '../../src/lib/ticker-quality';
import type { Browser, BrowserContext } from 'playwright';
import {
  type AppSettings,
  type RawInsiderTrade,
  type OptionsActivity,
  type Signal,
  type VixQuote,
  type ScrapeStatus,
  type ScrapeResult,
  type ScrapeError,
  type TickerAggregate,
  type InsiderTrackRecord,
  type FilingEvent,
  type PoliticianTrade,
  type DataQualityStat,
  type DataQualityReport,
  SCRAPER_SOURCES,
  SIDE_PIPELINE_SOURCES,
  isBigPlayerByCap,
  normalizeInsiderName,
  shrunkAccuracy,
  classifyTransaction,
  computeSourceHealth,
  evaluateAlertRules,
  MIN_TRACK_RECORD_TRADES,
  CONVICTION_THRESHOLDS,
  DEFAULT_SCORING_CONFIG,
} from '../../src/types';
import { launchBrowser, createContext, installChromium, type InsiderScraper, type OptionsScraper } from './browser';
import { sanitizeTickerRows, classifyStockPageResponse } from './util';
import { scoreTicker, isScoringEligible, getRankWeight, normalizeAggregateTrades } from '../scoring';
import type { DecisionContext } from '../../src/types/backtest';
import {
  insertSignals,
  recordTickerQuality,
  finishScrapeLog,
  startScrapeLog,
  getMostRecentSessionSignals,
  getTrackRecord,
  upsertTrackRecord,
  getLatestSignals,
  pruneOldData,
  getTickerMeta,
  upsertTickerMeta,
  upsertInsiderFlow,
  replaceInsiderSalesSnapshot,
  getNetInsiderFlow,
  upsertInsiderTrades,
  getRecentInsiderTrades,
  getRecentSourceBreakdowns,
  getAlertRules,
  getWatchlistTickers,
  upsertFilingEvents,
  getRecentFilingEvents,
  getShadowScoringConfig,
  upsertPoliticianTrades,
  getPoliticianTradesForTicker,
  getPoliticianTradeTickers,
} from '../database';
import { fetchInsiderTrackRecord } from './insiderHistory';
import { loadMergedStorageState, sourceUnlocked, isLoggedIn } from '../auth';

import { scrapeEdgar } from './edgar';
import { scrapeOpenInsider } from './openinsider';
import { scrapeFinviz, scrapeFinvizEarnings } from './finviz';
import { scrapeSecForm4 } from './secform4';
import { scrapeMarketBeat } from './marketbeat';
import { scrapeInsiderMonitor } from './insidermonitor';
import { scrapeQuiverQuant } from './quiverquant';
import { scrapeCeoWatcher } from './ceowatcher';
import { scrapeBarchart } from './barchart';
import { scrapeOptionStrat } from './optionstrat';
import { scrapeInsiderFinance } from './insiderfinance';
import { scrapeMarketBeatOptions } from './marketbeatoptions';
import { scrapeOpenInsiderSales, fetchEdgarForm144, getTickerNameMap, getRegisteredTickers, type InsiderFlowRow } from './sellside';
import { fetchActivistFilings } from './activist';
import {
  scrapeCapitolTradesApi,
  scrapeCapitolTradesPlaywright,
  scrapeQuiverCongressEmbed,
} from './capitoltrades';
import { scrapeCongressWatchers } from './senatewatcher';
import { fetchStockAnalysisStats, fetchDrawdown52w } from './stockstats';
import { fetchFairValue } from './fairValue';
import { calculateFairValue } from '../fairValue';
import { upgradeFairValue } from '../../src/lib/fairValueDisplay';
import { getAnalysisSnapshot } from '../analysisSnapshot';

/** Side-pipeline keys always included in session breakdown + health. */
const SIDE_KEYS = SIDE_PIPELINE_SOURCES.map((s) => s.key);

/**
 * Congressional data chain (hard-fails only if every layer fails):
 * 1) Capitol Trades BFF API
 * 2) Capitol Trades Playwright (+ network intercept) then Quiver HTML embed
 * 3) House/Senate STOCK Act watcher dumps (GitHub/jsDelivr mirrors)
 */
async function scrapeCongressChain(
  context: BrowserContext,
  reportIssue: (message: string) => void,
): Promise<{ trades: PoliticianTrade[]; layer: string }> {
  const layerErrors: string[] = [];

  try {
    const trades = await scrapeCapitolTradesApi(90, reportIssue);
    if (trades.length) return { trades, layer: 'capitol-api' };
    layerErrors.push('capitol-api: 0 rows');
  } catch (e) {
    layerErrors.push(`capitol-api: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const trades = await scrapeCapitolTradesPlaywright(context, 90);
    if (trades.length) return { trades, layer: 'capitol-playwright' };
    layerErrors.push('capitol-playwright: 0 rows');
  } catch (e) {
    layerErrors.push(`capitol-playwright: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const trades = await scrapeQuiverCongressEmbed(90);
    if (trades.length) return { trades, layer: 'quiver-embed' };
    layerErrors.push('quiver-embed: 0 rows');
  } catch (e) {
    layerErrors.push(`quiver-embed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const trades = await scrapeCongressWatchers(reportIssue);
    if (trades.length) return { trades, layer: 'house-senate-watchers' };
    layerErrors.push('house-senate-watchers: 0 rows');
  } catch (e) {
    layerErrors.push(`house-senate-watchers: ${e instanceof Error ? e.message : String(e)}`);
  }

  throw new Error(`All congressional layers failed: ${layerErrors.join(' | ')}`);
}

const INSIDER_SCRAPERS: Partial<Record<string, InsiderScraper>> = {
  edgar: scrapeEdgar,
  openinsider: scrapeOpenInsider,
  finviz: scrapeFinviz,
  secform4: scrapeSecForm4,
  marketbeat: scrapeMarketBeat,
  insidermonitor: scrapeInsiderMonitor,
  quiverquant: scrapeQuiverQuant,
  ceowatcher: scrapeCeoWatcher,
};

const OPTIONS_SCRAPERS: Partial<Record<string, OptionsScraper>> = {
  barchart: scrapeBarchart,
  optionstrat: scrapeOptionStrat,
  insiderfinance: scrapeInsiderFinance,
  marketbeatoptions: scrapeMarketBeatOptions,
};

const PER_SCRAPER_TIMEOUT_MS = 75_000;
const EARNINGS_TICKER_LIMIT = 25;
/** Pre-warm caps so building track records doesn't dominate the scrape (Feature 6). */
const PREWARM_INSIDER_LIMIT = 12;
const PREWARM_PER_INSIDER_MS = 20_000;
const PREWARM_TOTAL_BUDGET_MS = 60_000;
const TRACK_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Track-record errors that are permanent facts about the insider (cacheable).
 * Transient failures (nav timeouts, Yahoo 429s) must NOT be cached, or one
 * blip suppresses that insider's record for the whole TTL.
 */
const CACHEABLE_TRACK_RECORD_ERRORS: ReadonlySet<string> = new Set([
  'No post-trade performance data yet.',
  'No history page available for this insider.',
]);
/** Feature 9 — a score jump this large (and into ≥ WATCH) fires a "surge" alert. */
const SCORE_SURGE_DELTA = 25;
/**
 * Minimum single-print premium for a ticker to surface on options flow alone (a
 * "whale"). Matches the "big options flow" bar the combo detector uses, so a
 * ticker either stands alone as a whale signal or, with an insider buy on the
 * same name, becomes a combo.
 */
const MIN_OPTIONS_PREMIUM = 250_000;
/**
 * Trailing TRADE-date window that aggregates are built from (see the
 * `insider_trades` DDL). 30 days is not arbitrary: it is exactly the window
 * `getClusterMultiplier` counts distinct insiders over, and the freshness curve
 * has already bottomed out at its floor by ~17 days, so nothing inside this
 * window can score off a stale date without being discounted for it.
 */
const TRADE_WINDOW_DAYS = 30;

/**
 * Count how many of a source's rows the pipeline can actually use. Every check
 * mirrors a gate a row must pass later, so a rising number here is a scraper
 * that is DRIFTING, not a market that is quiet — the distinction the
 * `sourceBreakdown` row count alone cannot make.
 */
function recordTradeQuality(stat: DataQualityStat, rows: readonly RawInsiderTrade[], badTickers: number): void {
  stat.rows += rows.length;
  stat.badTicker += badTickers;
  for (const t of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.tradeDate ?? '')) stat.badDate++;
    if (!(Number.isFinite(t.value) && t.value > 0)) stat.noValue++;
    if (classifyTransaction(t.transactionType).modifier <= 0) stat.unknownType++;
    if (!(t.role ?? '').trim()) stat.noRole++;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Live status (also readable synchronously by the IPC status handler)
// ──────────────────────────────────────────────────────────────────────────

let currentStatus: ScrapeStatus = {
  running: false,
  phase: 'idle',
  completedSources: [],
  totalSources: 0,
  signalsFound: 0,
};
let scrapeInFlight = false;

export function getScrapeStatus(): ScrapeStatus {
  return currentStatus;
}


function mergeOptionsActivity(
  current: OptionsActivity[],
  previous: OptionsActivity[],
): OptionsActivity[] {
  const seen = new Set<string>();
  const merged: OptionsActivity[] = [];

  // Key on CONTRACT IDENTITY only (no volume/notional/sentiment): the same
  // contract re-scraped with intraday-updated volume must merge, not duplicate.
  // Current entries are inserted first, so the freshest snapshot wins.
  //
  // `source` is deliberately NOT part of the key. It used to be, so the same
  // print reported by two providers survived twice and `scoreOptionsDetailed`
  // counted it as two prints with geometric decay — 1.5× a single one. Measured
  // in the live history: 17 of 1210 contracts (e.g. QQQ 735C 2026-08-17 from
  // InsiderFinance at $120k and OptionStrat at $118k).
  const getOptionKey = (o: OptionsActivity) =>
    `${o.ticker.toUpperCase()}|${o.type}|${o.strike ?? 0}|${o.expiry ?? ''}`;

  const premium = (o: OptionsActivity) => o.premiumTotal ?? o.notional ?? 0;
  const byKey = new Map<string, number>(); // key → index into `merged`

  for (const o of current) {
    const key = getOptionKey(o);
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, merged.length);
      seen.add(key);
      merged.push(o);
    } else if (premium(o) > premium(merged[at])) {
      // Same contract from two providers in the SAME run: keep the fuller
      // report rather than whichever scraper happened to finish first.
      merged[at] = o;
    }
  }

  for (const o of previous) {
    const key = getOptionKey(o);
    if (!seen.has(key)) {
      seen.add(key);
      byKey.set(key, merged.length);
      merged.push(o);
    }
  }

  return merged;
}

// ──────────────────────────────────────────────────────────────────────────
// Merge + dedup
// ──────────────────────────────────────────────────────────────────────────

/** Run an async mapper over items with a bounded concurrency (a tiny pool). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      checkCancelled();
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Group all trades + matching options by ticker. A ticker qualifies only if it
 * has at least one scoring-eligible buy (modifier > 0) whose summed value meets
 * the minimum. Sales/awards are kept on the aggregate for display.
 */
function buildAggregates(
  trades: RawInsiderTrade[],
  options: OptionsActivity[],
  minDollarVolume: number,
): TickerAggregate[] {
  const deduped = dedupTrades(trades);

  // Cross-source corroboration (for the confidence score): distinct sources
  // that reported each ticker, counted BEFORE dedup collapses them.
  const sourcesByTicker = new Map<string, Set<string>>();
  for (const t of trades) {
    const set = sourcesByTicker.get(t.ticker) ?? new Set<string>();
    set.add(t.source);
    sourcesByTicker.set(t.ticker, set);
  }

  const optionsByTicker = new Map<string, OptionsActivity[]>();
  for (const o of options) {
    const list = optionsByTicker.get(o.ticker) ?? [];
    list.push(o);
    optionsByTicker.set(o.ticker, list);
  }

  const byTicker = new Map<string, TickerAggregate>();
  for (const t of deduped) {
    const agg = byTicker.get(t.ticker) ?? {
      ticker: t.ticker,
      companyName: t.companyName,
      trades: [],
      options: optionsByTicker.get(t.ticker) ?? [],
      sourceUrls: [],
    };
    agg.trades.push(t);
    if (!agg.companyName && t.companyName) agg.companyName = t.companyName;
    if (t.sourceUrl && !agg.sourceUrls.includes(t.sourceUrl)) agg.sourceUrls.push(t.sourceUrl);
    byTicker.set(t.ticker, agg);
  }

  // "Whale" aggregates: tickers with unusual options flow but no insider buy.
  // Without this branch the options ("whale") half of the app can never surface a
  // signal on its own — every options event would be discarded unless an insider
  // on the same ticker also happened to be buying.
  for (const [ticker, opts] of optionsByTicker) {
    if (byTicker.has(ticker)) continue; // already carried by an insider aggregate
    const sourceUrls: string[] = [];
    for (const o of opts) {
      if (o.sourceUrl && !sourceUrls.includes(o.sourceUrl)) sourceUrls.push(o.sourceUrl);
    }
    byTicker.set(ticker, { ticker, companyName: undefined, trades: [], options: opts, sourceUrls });
  }

  for (const agg of byTicker.values()) {
    agg.options = [...agg.options].sort((a, b) => b.notional - a.notional).slice(0, 10);
    // Whale-only aggregates corroborate via their options sources instead.
    const tradeSources = sourcesByTicker.get(agg.ticker)?.size ?? 0;
    agg.sourceCount = tradeSources > 0 ? tradeSources : new Set(agg.options.map((o) => o.source)).size || 1;
  }

  const eligibleVolume = (agg: TickerAggregate) =>
    agg.trades.filter(t => isScoringEligible(t)).reduce((s, t) => s + (t.value || 0), 0);
  // Whale-only tickers gate on BULLISH premium: a lone big bearish put would
  // otherwise surface as a permanent zero-score row (its composite floors at 0).
  // Bearish prints still ride along on insider-backed aggregates as a penalty.
  const topBullishPremium = (agg: TickerAggregate) =>
    agg.options.reduce(
      (m, o) => (o.sentiment === 'bullish' ? Math.max(m, o.premiumTotal ?? o.notional ?? 0) : m),
      0,
    );

  // Keep a ticker if EITHER it has a qualifying insider buy OR a whale-sized
  // options print. (A ticker with only a small insider buy but a whale print now
  // qualifies on the options leg, with the insider trades kept as context.)
  return [...byTicker.values()].filter((agg) => {
    const hasInsiderSignal = agg.trades.some(t => isScoringEligible(t)) && eligibleVolume(agg) >= minDollarVolume;
    const hasWhaleOptions = topBullishPremium(agg) >= MIN_OPTIONS_PREMIUM;
    return hasInsiderSignal || hasWhaleOptions;
  });
}

/**
 * Best *shrunk* market-beat rate among a ticker's eligible insiders (Feature 6).
 * Insiders below the minimum sample are ignored, and each remaining record is
 * regressed toward 0.5 so a 1-for-1 fluke can't hand the ticker a score boost.
 */
function lookupBestAccuracy(agg: TickerAggregate): number | undefined {
  let best: number | undefined;
  const seen = new Set<string>();
  for (const t of agg.trades) {
    if (!isScoringEligible(t)) continue;
    const key = normalizeInsiderName(t.insiderName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rec = getTrackRecord(t.insiderName);
    if (rec && rec.totalTrades >= MIN_TRACK_RECORD_TRADES) {
      const acc = shrunkAccuracy(rec.profitable3m, rec.totalTrades);
      best = best == null ? acc : Math.max(best, acc);
    }
  }
  return best;
}

/**
 * Pre-warm insider track records during the scrape so the trackRecordMultiplier
 * is actually populated at scoring time (otherwise the cache is only filled when a
 * user opens a detail modal, and the factor is effectively inert). Bounded by an
 * insider cap, per-insider timeout, and overall budget; cached records within TTL
 * are skipped, and results are persisted so later scrapes mostly hit the cache.
 */
async function prewarmTrackRecords(context: BrowserContext, aggregates: TickerAggregate[]): Promise<void> {
  const eligibleVolume = (agg: TickerAggregate) =>
    agg.trades.filter(t => isScoringEligible(t)).reduce((s, t) => s + (t.value || 0), 0);
  const ranked = [...aggregates].sort((a, b) => eligibleVolume(b) - eligibleVolume(a));

  const targets: { name: string; role?: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const agg of ranked) {
    for (const t of agg.trades) {
      if (!isScoringEligible(t) || !t.insiderUrl) continue;
      const key = normalizeInsiderName(t.insiderName);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cached = getTrackRecord(t.insiderName);
      const fresh =
        cached && Date.now() - Date.parse(cached.lastUpdated) < TRACK_RECORD_TTL_MS && (cached.totalTrades > 0 || !!cached.error);
      if (fresh) continue;
      targets.push({ name: t.insiderName, role: t.role, url: t.insiderUrl });
      if (targets.length >= PREWARM_INSIDER_LIMIT) break;
    }
    if (targets.length >= PREWARM_INSIDER_LIMIT) break;
  }
  if (targets.length === 0) return;

  const deadline = Date.now() + PREWARM_TOTAL_BUDGET_MS;
  await mapLimit(targets, 3, async (tg) => {
    if (Date.now() > deadline) return;
    try {
      const rec = await withTimeout<InsiderTrackRecord | null>(
        () => fetchInsiderTrackRecord(context, tg.name, tg.url, tg.role),
        PREWARM_PER_INSIDER_MS,
        null,
      );
      if (rec && (rec.totalTrades > 0 || (rec.error && CACHEABLE_TRACK_RECORD_ERRORS.has(rec.error)))) {
        upsertTrackRecord(rec);
      }
    } catch {
      /* best-effort */
    }
  });
}


// ──────────────────────────────────────────────────────────────────────────
// Orchestrator
// ──────────────────────────────────────────────────────────────────────────

export interface StockAnalysisData {
  earningsDate?: string;
  daysToEarnings?: number;
  earningsTiming?: 'AMC' | 'BMO';
  marketCap?: number;
  sector?: string;
  /**
   * The symbol has no page here at all (definitive 404) — as opposed to a
   * transient failure. Only a definitive miss may be cached negatively; caching
   * a timeout or a 429 would suppress a real ticker for the whole TTL. Same
   * distinction the track-record cache already makes.
   */
  notFound?: boolean;
}

/** Enrichment values change at most daily; cached rows older than this refetch. */
const TICKER_META_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Order the enrichment phase by how much the score actually depends on the
 * answer. The phase runs under a hard 60s budget, so when the budget runs out
 * the cut-off has to fall on the aggregates that need enrichment least —
 * otherwise which tickers get a `marketCap` is decided by array position.
 *
 * That matters more than it looks: `marketCap` is what selects the ladder in
 * `getDollarVolumePoints`, and the absolute fallback ladder scores the same buy
 * several times higher than the cap-relative one. An arbitrary cut-off means an
 * arbitrary subset of signals is scored on the generous scale.
 *
 * `prewarmTrackRecords` and the Finviz fallback already rank their work; this
 * phase was the only one that did not. Politician-only aggregates carry neither
 * trades nor options and therefore sort last, which is correct — they are
 * dropped as content-free after scoring anyway.
 */
function rankedForEnrichment(aggregates: TickerAggregate[]): TickerAggregate[] {
  const weight = (agg: TickerAggregate): number => {
    const insider = agg.trades.filter(t => isScoringEligible(t)).reduce((s, t) => s + (t.value || 0), 0);
    const options = agg.options.reduce((m, o) => Math.max(m, o.premiumTotal ?? o.notional ?? 0), 0);
    return Math.max(insider, options);
  };
  return [...aggregates].sort((a, b) => weight(b) - weight(a));
}

/** Whole-calendar-day countdown to a YYYY-MM-DD date (0 = today, negative = past). */
function daysUntil(dateIso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return Math.round((target - startOfToday.getTime()) / 86_400_000);
}

/** Parse a market-cap string like "1.23T" / "456.7B" / "12.34M" into a number. */
function parseMarketCap(raw: string): number | undefined {
  const m = raw.replace(/[,$\s]/g, '').match(/(\d*\.?\d+)\s*([tbmk])?/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const suffix = (m[2] || '').toLowerCase();
  const mult = suffix === 't' ? 1e12 : suffix === 'b' ? 1e9 : suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return n * mult;
}

/** One stockanalysis.com fetch → next-earnings date + market cap (either may be absent). */
export async function fetchStockAnalysisEarnings(ticker: string): Promise<StockAnalysisData | null> {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  try {
    const url = `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/`;
    // Hard timeout: undici's defaults allow a stalled socket to hang for
    // minutes, and this runs inside the scrape's enrichment phase.
    const resp = await scopedFetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    // Cacheability of a miss is decided in one place (util) so it can be
    // unit-tested without a network. Measured: AALK 404s, QQQ/SPY/FB return
    // 200 but redirect away from /stocks/, ALK and ABBV are real 200s.
    const verdict = classifyStockPageResponse(resp.status, resp.redirected);
    if (verdict === 'missing') return { notFound: true };
    if (verdict === 'transient') return null;
    const html = await resp.text();
    // stockanalysis.com wraps labels in anchors and sprinkles framework comment
    // markers between label and value; strip comments, then match the label
    // through an optional closing anchor so both layouts parse.
    const cleaned = html.replace(/<!--[\s\S]*?-->/g, '');
    const out: StockAnalysisData = {};

    const capMatch = cleaned.match(/Market Cap(?:<\/a>)?<\/td><td[^>]*>\s*([^<]+)/i);
    if (capMatch) out.marketCap = parseMarketCap(capMatch[1].trim());

    const secMatch = cleaned.match(/>Sector<\/span>\s*<a[^>]*>([^<]+)/i);
    if (secMatch) {
      const sector = secMatch[1].trim();
      if (sector && sector !== '-' && sector !== '—') out.sector = sector;
    }

    const m = cleaned.match(/Earnings Date(?:<\/a>)?<\/td><td[^>]*>\s*([^<]+)/i);
    const dateStr = m?.[1]?.trim();
    if (dateStr && dateStr !== '—' && dateStr !== '-') {
      const parsed = new Date(dateStr);
      if (!Number.isNaN(parsed.getTime())) {
        const y = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        out.earningsDate = `${y}-${month}-${d}`;
        // Whole-calendar-day countdown (midnight to midnight): an earnings
        // report later TODAY must read 0, not −1, or it forfeits the timing boost.
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        out.daysToEarnings = Math.round((parsed.getTime() - startOfToday.getTime()) / 86_400_000);
        // Best-effort AMC/BMO from the cell (so this path isn't always blank on timing).
        const t = dateStr.toLowerCase();
        if (/\b(amc|after[- ]?(market|hours|close))\b/.test(t)) out.earningsTiming = 'AMC';
        else if (/\b(bmo|before[- ]?(market|open)|pre[- ]?market)\b/.test(t)) out.earningsTiming = 'BMO';
      }
    }
    return out;
  } catch (err) {
    console.error(`Stock Analysis fetch failed during orchestrator run for ${ticker}:`, err);
    return null;
  }
}

export interface RunScrapeOptions {
  settings: AppSettings;
  /** Feature 8 — current VIX value to fold into scoring + scrape_log. */
  vix?: number;
  vixQuote?: VixQuote | null;
  onStatus?: (status: ScrapeStatus) => void;
}

export async function runScrape(opts: RunScrapeOptions): Promise<ScrapeResult> {
  const startedAt = new Date().toISOString();

  if (scrapeInFlight) {
    return {
      status: 'failed',
      signalsFound: 0,
      signals: [],
      sourcesScraped: [],
      errors: [{ source: 'orchestrator', message: 'A scrape is already running.' }],
      newHighConviction: [],
      newCombos: [],
      scoreSurges: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  scrapeInFlight = true;
  // finally-guarded so a throw anywhere (e.g. a DB error before the browser
  // try block) can't leave the flag stuck with every later scrape reporting
  // "already running" until the app restarts.
  try {
    return await runScrapeInner(opts, startedAt);
  } finally {
    scrapeInFlight = false;
  }
}

async function runScrapeInner(opts: RunScrapeOptions, startedAt: string): Promise<ScrapeResult> {
  const { settings, vix } = opts;

  // Enabled + unlocked: a login-required source is skipped until authenticated.
  const enabled = SCRAPER_SOURCES.filter((s) => settings.sources[s.key] && sourceUnlocked(s.key));
  const errors: ScrapeError[] = [];
  const setStatus = (patch: Partial<ScrapeStatus>) => {
    currentStatus = { ...currentStatus, ...patch };
    opts.onStatus?.(currentStatus);
  };

  if (enabled.length === 0) {
    const errorMsg = 'No enabled scraper sources are unlocked. Please log in or enable free sources in Settings.';
    setStatus({
      running: false,
      phase: 'Done',
      error: errorMsg,
    });
    return {
      status: 'failed',
      signalsFound: 0,
      signals: [],
      sourcesScraped: [],
      errors: [{ source: 'orchestrator', message: errorMsg }],
      newHighConviction: [],
      newCombos: [],
      scoreSurges: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // Side pipelines always run (congress / sellside / activist) and count toward progress.
  const totalTracked = enabled.length + SIDE_KEYS.length;
  setStatus({
    running: true,
    phase: 'Launching browser…',
    currentSource: undefined,
    completedSources: [],
    totalSources: totalTracked,
    signalsFound: 0,
    startedAt,
    error: undefined,
  });

  const logId = startScrapeLog([...enabled.map((s) => s.key), ...SIDE_KEYS]);

  // Tickers that were HIGH / combo last session (for "new" detection), plus their
  // prior scores so we can flag sharp jumps (Feature 9).
  const lastSession = getMostRecentSessionSignals();
  const previousHigh = new Set(lastSession.filter((s) => s.convictionLevel === 'HIGH').map((s) => s.ticker));
  // Classic combo OR any politician combo tier counted as "already notified combo".
  const previousCombo = new Set(
    lastSession.filter((s) => s.comboSignal || !!s.breakdown?.politicianComboTier).map((s) => s.ticker),
  );
  const previousScores = new Map(lastSession.map((s) => [s.ticker, s.score]));

  let browser: Browser | null = null;
  const allTrades: RawInsiderTrade[] = [];
  const allOptions: OptionsActivity[] = [];
  const completed: string[] = [];
  let aggregates: TickerAggregate[] = [];
  let newFilingEvents: FilingEvent[] = [];
  let newPoliticianTrades = 0;
  // Side-pipeline + main-source row counts for session breakdown / health.
  // Sentinel -1 = hard fail (timeout/error); 0 = ran cleanly with no rows.
  const sideCounts: Record<string, number> = {
    sellside: 0,
    activist: 0,
    capitoltrades: 0,
  };
  const mainSourceCounts: Record<string, number> = {};
  /**
   * Per-source data-quality counters for this run. A scraper that returns rows
   * the pipeline then throws away is indistinguishable, in `sourceBreakdown`,
   * from a scraper that is working — this is what makes that visible.
   */
  const quality: Record<string, DataQualityStat> = {};
  const qualityFor = (key: string): DataQualityStat =>
    (quality[key] ??= { rows: 0, badTicker: 0, repairedTicker: 0, badDate: 0, noValue: 0, unknownType: 0, noRole: 0 });

  try {
    try {
      browser = await launchBrowser(settings.headless);
    } catch (err: any) {
      const isMissingBrowser =
        err.message.includes("Executable doesn't exist") ||
        err.message.includes('Please run the following command to download new browsers');
      if (isMissingBrowser) {
        setStatus({ phase: 'Installing Chromium browser (one-time download)...', currentSource: 'Playwright Setup' });
        await installChromium();
        browser = await launchBrowser(settings.headless);
      } else {
        throw err;
      }
    }
    const context = await createContext(browser, loadMergedStorageState());

    // SEC symbol registry — the oracle for repairing doubled first letters (see
    // repairDoubledTicker). Fetched once per run, cached 24h inside sellside.ts,
    // and best-effort: with no registry, no ticker is ever "repaired".
    let registered: Set<string> = new Set();
    try {
      registered = await withTimeout(() => getRegisteredTickers(), 20_000, new Set<string>());
    } catch {
      /* best-effort — an empty set simply disables the repair */
    }
    const isRegistered = (t: string) => registered.has(t);
    if (registered.size === 0) {
      console.warn('[scraper] SEC symbol registry unavailable — doubled-ticker repair disabled this run');
    }

    // Sources are independent (each opens its own page on the shared context,
    // different domains), so run a small pool instead of strictly sequential —
    // cuts wall-clock scrape time ~2–3×. Pushes are synchronous, so the shared
    // arrays are safe on the single-threaded event loop.
    // Per-source status written into outer `mainSourceCounts` (do NOT redeclare
    // here — a shadowed local previously left the breakdown all zeros while
    // trades still flowed into signals).
    await mapLimit([...enabled], 3, async (source) => {
      setStatus({ phase: `Scraping ${source.label}…`, currentSource: source.label });
      try {
        if (source.kind === 'insider') {
          const fn = INSIDER_SCRAPERS[source.key];
          if (!fn) {
            mainSourceCounts[source.key] = 0;
          } else {
            const timedOut = Symbol('timeout');
            let acceptingIssues = true;
            const result = await withTimeout<RawInsiderTrade[] | typeof timedOut>(
              () => fn(context, (message) => { if (acceptingIssues) errors.push({ source: source.key, message }); }),
              PER_SCRAPER_TIMEOUT_MS, timedOut,
            ).finally(() => { acceptingIssues = false; });
            if (result === timedOut) {
              mainSourceCounts[source.key] = -1;
              errors.push({ source: source.key, message: `Timed out after ${PER_SCRAPER_TIMEOUT_MS}ms` });
            } else {
              const { kept, rejected, repaired } = sanitizeTickerRows(
                result,
                registered.size ? isRegistered : undefined,
              );
              const q = qualityFor(source.key);
              recordTradeQuality(q, result, rejected.length);
              q.repairedTicker += repaired;
              allTrades.push(...kept);
              // Counted BEFORE the gate, so `sourceBreakdown` keeps meaning
              // "rows this source produced" and the quality block reports what
              // was dropped. Two different questions, two different numbers.
              mainSourceCounts[source.key] = result.length;
            }
          }
        } else {
          const fn = OPTIONS_SCRAPERS[source.key];
          if (!fn) {
            mainSourceCounts[source.key] = 0;
          } else {
            const timedOut = Symbol('timeout');
            const result = await withTimeout<OptionsActivity[] | typeof timedOut>(() => fn(context), PER_SCRAPER_TIMEOUT_MS, timedOut);
            if (result === timedOut) {
              mainSourceCounts[source.key] = -1;
              errors.push({ source: source.key, message: `Timed out after ${PER_SCRAPER_TIMEOUT_MS}ms` });
            } else {
              const { kept, rejected, repaired } = sanitizeTickerRows(
                result,
                registered.size ? isRegistered : undefined,
              );
              const q = qualityFor(source.key);
              q.rows += result.length;
              q.badTicker += rejected.length;
              q.repairedTicker += repaired;
              for (const o of result) if (!((o.premiumTotal ?? o.notional ?? 0) > 0)) q.noValue++;
              allOptions.push(...kept);
              mainSourceCounts[source.key] = result.length;
            }
          }
        }
      } catch (err) {
        mainSourceCounts[source.key] = -1;
        errors.push({ source: source.key, message: err instanceof Error ? err.message : String(err) });
      }
      completed.push(source.key);
      setStatus({ completedSources: [...completed] });
    });

    // ── Persist this scrape's trades, then rebuild the working set from the
    // trailing window (see TRADE_WINDOW_DAYS). Every source is a "latest
    // filings" feed with its own short horizon, so without this a trade exists
    // only while its source page still lists it — and a single failed scrape
    // silently zeroes out every signal that source was carrying.
    // `allTrades` itself is deliberately NOT reassigned: the metrics
    // consistency check below compares per-source counts against exactly the
    // rows this run scraped.
    let mergedTrades: RawInsiderTrade[] = allTrades;
    try {
      const newTrades = upsertInsiderTrades(allTrades);
      const windowTrades = getRecentInsiderTrades(TRADE_WINDOW_DAYS);
      // Only canonical admissible versions may re-enter the pipeline. An empty
      // verified window must not reactivate unresolved live rows.
      mergedTrades = windowTrades;
      console.log(
        `[scraper] insider trades: ${allTrades.length} scraped (${newTrades} new), ` +
          `${mergedTrades.length} in the ${TRADE_WINDOW_DAYS}d window`,
      );
    } catch (err) {
      mergedTrades = [];
      console.error('[scraper] insider-trade persistence failed — withholding unverified live rows:', err);
      errors.push({
        source: 'insider-trades',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    mergedTrades = mergedTrades.filter((t) => !tickerIssue(t.ticker)).map((t) => ({ ...t, ticker: resolvedTicker(t.ticker, t.tradeDate) }));

    // Sell-side intelligence — collect same-company sale flow + Form 144
    // notices into insider_flow. Context/display only; failures never block
    // the signal pipeline.
    setStatus({ phase: 'Collecting sell-side flow…', currentSource: 'Sell-side flow' });
    try {
      const issue = (message: string) => { checkCancelled(); errors.push({ source: 'sellside', message }); };
      const [salesResult, formResult] = await Promise.allSettled([
        withTimeout(() => scrapeOpenInsiderSales(context, issue), 60_000, null),
        withTimeout(() => fetchEdgarForm144(issue), 45_000, null),
      ]);
      let successful = 0;
      let count = 0;
      if (salesResult.status === 'fulfilled' && salesResult.value?.complete) {
        replaceInsiderSalesSnapshot(salesResult.value); successful++; count += salesResult.value.rows.length;
      } else issue('OpenInsider sales snapshot unavailable or incomplete');
      if (formResult.status === 'fulfilled' && formResult.value) {
        upsertInsiderFlow(formResult.value); successful++; count += formResult.value.length;
      } else issue('Form 144 collector failed or timed out');
      if (!successful) throw new Error('Both sell-side collectors failed to produce usable coverage');
      sideCounts.sellside = count;
    } catch (err) {
      sideCounts.sellside = -1;
      errors.push({ source: 'sellside', message: err instanceof Error ? err.message : String(err) });
    }
    completed.push('sellside');
    setStatus({ completedSources: [...completed] });

    // 13D/13G activist radar — 5%+ stake disclosures (plain EDGAR Atom fetch;
    // no browser). New filings notify like combos and badge matching signals.
    setStatus({ phase: 'Checking 13D/13G filings…', currentSource: 'Activist radar' });
    try {
      const events = await withTimeout(() => fetchActivistFilings(message => { checkCancelled(); errors.push({ source: 'activist', message }); }), 45_000, null as FilingEvent[] | null);
      if (events == null) throw new Error('Activist filings timed out');
      if (events.length) newFilingEvents = upsertFilingEvents(events);
      sideCounts.activist = events.length;
    } catch (err) {
      sideCounts.activist = -1;
      errors.push({ source: 'activist', message: err instanceof Error ? err.message : String(err) });
    }
    completed.push('activist');
    setStatus({ completedSources: [...completed] });

    // Congressional trading — multi-layer chain (API → Playwright → Quiver → dumps).
    // Hard failure only if every layer fails; then health sees -1 and errors[].
    setStatus({ phase: 'Checking congressional trades…', currentSource: 'Congressional Trades' });
    try {
      const congress = await withTimeout(() => scrapeCongressChain(context, message => { checkCancelled(); errors.push({ source: 'capitoltrades', message }); }), 120_000, null);
      if (!congress) throw new Error('Congress collectors timed out');
      const { trades: rawPoliticianTrades, layer } = congress;
      const { kept: politicianTrades, rejected: badPoliticianTickers, repaired } = sanitizeTickerRows(
        rawPoliticianTrades,
        registered.size ? isRegistered : undefined,
      );
      const q = qualityFor('capitoltrades');
      q.rows += rawPoliticianTrades.length;
      q.badTicker += badPoliticianTickers.length;
      q.repairedTicker += repaired;
      newPoliticianTrades = upsertPoliticianTrades(politicianTrades);
      sideCounts.capitoltrades = rawPoliticianTrades.length;
      console.log(
        `[scraper] congressional trades via ${layer}: ${politicianTrades.length} scraped, ${newPoliticianTrades} new`,
      );
    } catch (err) {
      sideCounts.capitoltrades = -1;
      errors.push({
        source: 'capitoltrades',
        message: err instanceof Error ? err.message : String(err),
      });
      console.error('[scraper] congressional trades FAILED all layers:', err);
    }
    completed.push('capitoltrades');
    setStatus({ completedSources: [...completed] });

    // Assign discovery timestamp to currently scraped options
    const scrapeTime = new Date().toISOString();
    for (const o of allOptions) {
      if (!o.scrapedAt) {
        o.scrapedAt = scrapeTime;
      }
    }

    // Fetch previous signals to retrieve unexpired options flow alerts
    let previousOptions: OptionsActivity[] = [];
    try {
      const latestSignals = getLatestSignals();
      const OPTIONS_FLOW_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
      const cutoff = Date.now() - OPTIONS_FLOW_TTL_MS;

      for (const sig of latestSignals) {
        if (sig.optionsActivity && sig.optionsActivity.length > 0) {
          for (const o of sig.optionsActivity) {
            const optTime = o.scrapedAt ? Date.parse(o.scrapedAt) : Date.parse(sig.scrapedAt);
            if (!Number.isNaN(optTime) && optTime >= cutoff) {
              if (!o.scrapedAt) {
                o.scrapedAt = new Date(optTime).toISOString();
              }
              previousOptions.push(o);
            }
          }
        }
      }
    } catch (dbErr) {
      console.error('[scraper] Failed to fetch previous options for merge:', dbErr);
    }

    const mergedOptions = mergeOptionsActivity(allOptions, previousOptions);

    // Settings → role-category filters: drop trades whose insider category the
    // user disabled (missing keys default to allowed, matching the Settings UI).
    const roleAllowed = (role: string) => settings.roleFilters[getRankWeight(role).category] !== false;
    const filteredTrades = mergedTrades.filter((t) => roleAllowed(t.role));

    // Build candidate aggregates, then enrich with earnings (Feature 5).
    aggregates = buildAggregates(filteredTrades, mergedOptions, settings.minDollarVolume);

    // Merge congressional trades (trailing 90d, from the DB so historical scrapes
    // count) into matching aggregates, and add politician-only aggregates so a
    // lone congressional buy can surface as a first-class signal on its own.
    try {
      const existing = new Set(aggregates.map((a) => a.ticker));
      for (const agg of aggregates) {
        const pts = getPoliticianTradesForTicker(agg.ticker, 90);
        if (pts.length) agg.politicianTrades = pts;
      }
      for (const ticker of getPoliticianTradeTickers(90)) {
        if (existing.has(ticker)) continue;
        const pts = getPoliticianTradesForTicker(ticker, 90);
        if (!pts.some((t) => t.transactionType === 'buy')) continue; // buys only surface alone
        aggregates.push({ ticker, trades: [], options: [], politicianTrades: pts, sourceUrls: [] });
      }
    } catch (err) {
      console.error('[scraper] politician-trade merge failed:', err);
    }

    // Company names for aggregates that have none — options-only ("whale") tickers
    // never get one, because the options scrapers report no company name. The SEC's
    // company_tickers.json is already fetched for the CIK map, so this is free.
    if (aggregates.length) {
      try {
        const names = await withTimeout(() => getTickerNameMap(), 20_000, new Map<string, string>());
        for (const agg of aggregates) {
          if (!agg.companyName) {
            const name = names.get(agg.ticker.toUpperCase());
            if (name) agg.companyName = name;
          }
        }
      } catch {
        /* best-effort — a missing name only affects display */
      }
    }

    if (aggregates.length) {
      setStatus({ phase: 'Fetching earnings dates…', currentSource: 'Earnings fetch' });
      
      const remainingTickers: string[] = [];

      // 1. SQLite meta cache first (market cap / sector / earnings change at most
      //    daily), then stockanalysis.com for cache misses. Bounded concurrency so a
      //    big batch doesn't fire 100+ simultaneous requests (rate-limit/socket burst),
      //    plus a total phase budget so a degraded host can't stall the scrape.
      const enrichmentCompleted = await withTimeout<boolean>(
        () => mapLimit(rankedForEnrichment(aggregates), 6, async (agg) => {
          let cached: ReturnType<typeof getTickerMeta> = null;
          try {
            cached = getTickerMeta(agg.ticker, TICKER_META_TTL_MS);
          } catch {
            /* cache is best-effort */
          }
          if (cached) {
            if (cached.marketCap) agg.marketCap = cached.marketCap;
            if (cached.sector) agg.sector = cached.sector;
            if (
              cached.shortPctFloat != null ||
              cached.floatShares != null ||
              cached.avgDollarVolume != null ||
              cached.pctFrom52wHigh != null
            ) {
              agg.stats = {
                shortPctFloat: cached.shortPctFloat,
                floatShares: cached.floatShares,
                avgDollarVolume: cached.avgDollarVolume,
                pctFrom52wHigh: cached.pctFrom52wHigh,
              };
            }
            if (cached.earningsDate) {
              agg.earningsDate = cached.earningsDate;
              // Recompute the countdown locally — never cache a countdown.
              const d = daysUntil(cached.earningsDate);
              if (d != null) agg.daysToEarnings = d;
              if (cached.earningsTiming === 'AMC' || cached.earningsTiming === 'BMO') {
                agg.earningsTiming = cached.earningsTiming;
              }
            } else if (cached.marketCap != null || cached.sector != null) {
              remainingTickers.push(agg.ticker); // earnings still missing → Finviz fallback
            }
            // else: a negative-cache row (nothing found at all). Sending it to
            // the Playwright fallback every run is the same wasted budget in a
            // different phase.
            return;
          }
          const e = await fetchStockAnalysisEarnings(agg.ticker);
          checkCancelled();
          if (e?.marketCap) agg.marketCap = e.marketCap;
          if (e?.sector) agg.sector = e.sector;
          if (e?.earningsDate) {
            agg.daysToEarnings = e.daysToEarnings;
            agg.earningsDate = e.earningsDate;
            if (e.earningsTiming) agg.earningsTiming = e.earningsTiming;
          } else {
            remainingTickers.push(agg.ticker); // earnings still missing → Finviz fallback
          }
          // Equity stats pack (same host, /statistics/ page): short interest,
          // float, average volume. Average DOLLAR volume is derived from the
          // per-share price implied by cap ÷ shares outstanding — no extra
          // price parsing, and both inputs are exact-page values.
          const stats = await fetchStockAnalysisStats(agg.ticker);
          checkCancelled();
          let avgDollarVolume: number | undefined;
          if (stats?.avgVolume && e?.marketCap && stats.sharesOutstanding) {
            avgDollarVolume = stats.avgVolume * (e.marketCap / stats.sharesOutstanding);
          }
          // Price context at the buy: drawdown from 52w high as of freshest trade date.
          const asOfTrade =
            agg.trades
              .filter(t => isScoringEligible(t))
              .map((t) => t.tradeDate)
              .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
              .sort()
              .pop() ?? undefined;
          const pctFrom52wHigh = await fetchDrawdown52w(agg.ticker, asOfTrade);
          checkCancelled();
          if (
            (stats && (stats.shortPctFloat != null || stats.floatShares != null || avgDollarVolume != null)) ||
            pctFrom52wHigh != null
          ) {
            agg.stats = {
              shortPctFloat: stats?.shortPctFloat,
              floatShares: stats?.floatShares,
              avgDollarVolume,
              pctFrom52wHigh,
            };
          }
          if ((e && (e.marketCap || e.sector || e.earningsDate)) || stats || pctFrom52wHigh != null) {
            try {
              upsertTickerMeta({
                ticker: agg.ticker,
                marketCap: e?.marketCap,
                sector: e?.sector,
                earningsDate: e?.earningsDate,
                earningsTiming: e?.earningsTiming,
                shortPctFloat: stats?.shortPctFloat,
                floatShares: stats?.floatShares,
                avgDollarVolume,
                pctFrom52wHigh,
              });
            } catch {
              /* cache is best-effort */
            }
          } else if (e?.notFound) {
            // Negative cache. Without it, a symbol with no page here — a bad
            // ticker, an ETF, a delisted name — is retried on EVERY run at up to
            // three requests each. 240 of 689 tickers were in exactly that state
            // (143 of them the doubled-ticker corruption), and those retries
            // consumed the whole 60s budget every run, which is why enrichment
            // plateaued at 449. A row with no data but a fresh `fetched_at`
            // records "we looked, there is nothing".
            try {
              upsertTickerMeta({ ticker: agg.ticker });
            } catch {
              /* cache is best-effort */
            }
          }
        }).then(() => true),
        60_000,
        false,
      );
      // Enrichment coverage is not cosmetic: a missing marketCap silently moves
      // a signal onto the ABSOLUTE ladder in getDollarVolumePoints, which scores
      // the same buy several times higher than the cap-relative one. Coverage
      // had plateaued at 449 of 689 tickers with nothing reporting it.
      const withCap = aggregates.filter((a) => a.marketCap != null).length;
      console.log(`[scraper] enrichment: ${withCap}/${aggregates.length} aggregate(s) have a marketCap`);
      if (!enrichmentCompleted) {
        console.warn(
          '[scraper] enrichment budget (60s) expired before every aggregate was processed — ' +
            'the ranking puts the least significant ones last, but coverage is incomplete',
        );
      }

      // 2. Fallback to Finviz Playwright quote page scraper for any remaining tickers
      if (remainingTickers.length) {
        const sortedRemaining = [...aggregates]
          .filter((a) => remainingTickers.includes(a.ticker))
          .sort(
            (a, b) =>
              b.trades.reduce((s, t) => s + (t.value || 0), 0) - a.trades.reduce((s, t) => s + (t.value || 0), 0),
          )
          .map((a) => a.ticker);

        try {
          const earnings = await withTimeout(
            () => scrapeFinvizEarnings(context, sortedRemaining, EARNINGS_TICKER_LIMIT, 80_000),
            90_000,
            new Map(),
          );
          for (const agg of aggregates) {
            if (agg.earningsDate) continue; // already fetched via stockanalysis
            const e = earnings.get(agg.ticker);
            if (e) {
              agg.daysToEarnings = e.daysToEarnings;
              agg.earningsDate = e.earningsDate;
              agg.earningsTiming = e.earningsTiming;
            }
          }
        } catch (err) {
          errors.push({ source: 'finviz-earnings', message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // Pre-warm insider track records (Feature 6) so the trackRecordMultiplier is
    // populated at scoring time rather than only after a user opens a detail modal.
    if (aggregates.length) {
      setStatus({ phase: 'Building insider track records…', currentSource: 'Track records' });
      try {
        await prewarmTrackRecords(context, aggregates);
      } catch (err) {
        errors.push({ source: 'track-records', message: err instanceof Error ? err.message : String(err) });
      }
    }

    await context.close().catch(() => undefined);
  } catch (err) {
    errors.push({ source: 'browser', message: err instanceof Error ? err.message : String(err) });
  } finally {
    await browser?.close().catch(() => undefined);
  }

  // ── Enrich + score ───────────────────────────────────────────────────────
  setStatus({ phase: 'Calculating fair values…', currentSource: undefined });
  // Initialize EVERY candidate, including those beyond the bounded network phase.
  // The breakdown persists the inputs, provenance and valuation without a schema migration.
  for (const agg of aggregates) agg.fairValue = getAnalysisSnapshot(agg.ticker)?.valuation ?? calculateFairValue({}, Date.now(), ['Fundamentals not fetched within this run budget']);
  const valuationCache = new Map<string, Signal>();
  try { for (const s of getLatestSignals()) valuationCache.set(s.ticker, s); } catch { /* first run */ }
  const valuationPending: TickerAggregate[] = [];
  for (const agg of aggregates.filter(a => !tickerIssue(a.ticker))) {
    const saved = valuationCache.get(agg.ticker)?.breakdown.fairValue;
    const stored = saved && upgradeFairValue(saved);
    const previous = agg.fairValue?.fairValue != null ? agg.fairValue : stored;
    const age = previous ? Date.now() - Date.parse(previous.calculatedAt) : Infinity;
    if (previous?.version === 3 && age >= 0 && age < (previous.status === 'unavailable' ? 900_000 : 21_600_000)) {
      agg.fairValue = previous;
    } else {
      valuationPending.push(agg);
    }
  }
  // Rotate deferred/failed tickers ahead of recently refreshed ones on subsequent runs.
  valuationPending.sort((a, b) => {
    const last = (ticker: string) => {
      const r = valuationCache.get(ticker)?.breakdown.fairValue;
      return r && Object.keys(r.inputs).length ? Date.parse(r.calculatedAt) : 0;
    };
    return last(a.ticker) - last(b.ticker);
  });
  await withTimeout(() => mapLimit(valuationPending, 2, async agg => {
    const result = await fetchFairValue(agg.ticker);
    checkCancelled();
    if (result.fairValue != null || agg.fairValue?.fairValue == null) agg.fairValue = result;
  }).then(() => true), 90_000, false);
  for (const agg of aggregates) if (agg.fairValue) agg.fairValue = upgradeFairValue(agg.fairValue);
  setStatus({ phase: 'Merging & scoring…', currentSource: undefined });

  const scrapedAt = new Date().toISOString();
  // Shadow (A/B) config: when set, every aggregate is ALSO scored under the
  // candidate weights so live-vs-shadow IC can be compared once outcomes ripen.
  let shadowConfig: typeof DEFAULT_SCORING_CONFIG | null = null;
  try {
    const partial = getShadowScoringConfig();
    if (partial) shadowConfig = { ...DEFAULT_SCORING_CONFIG, ...partial };
  } catch {
    /* shadow scoring is best-effort */
  }
  const decisionContexts: Record<string, DecisionContext> = {};
  let signals: Signal[] = aggregates.filter((agg) => {
    if (!tickerIssue(agg.ticker)) return true;
    recordTickerQuality(agg.ticker);
    return false;
  }).map((agg) => {
    agg.vix = vix;
    agg.bestAccuracy3m = lookupBestAccuracy(agg);
    // Sell-side context: only attach when there is actual flow on record so
    // scoring notes stay quiet for tickers with no history.
    try {
      const flow = getNetInsiderFlow(agg.ticker, 90);
      if (flow.buys + flow.sells + flow.form144 > 0 || flow.unresolvedBuys) agg.insiderFlow = flow;
    } catch {
      /* flow context is best-effort */
    }
    // Activist context: recent 13D/13G filings on this ticker.
    try {
      const filings = getRecentFilingEvents(agg.ticker, 90);
      if (filings.length) agg.filingEvents = filings;
    } catch {
      /* filing context is best-effort */
    }
    // scoreTicker is pure, so the repaired amounts have to be written onto the
    // aggregate explicitly — `agg.trades` is what gets persisted and rendered.
    normalizeAggregateTrades(agg);
    const scoringAt = Date.now();
    const scored = scoreTicker(agg, DEFAULT_SCORING_CONFIG, scoringAt);
    const trackRecords = [...new Set(agg.trades.map(t => t.insiderName))].map(name => getTrackRecord(name)).filter((r): r is InsiderTrackRecord => r != null);
    decisionContexts[agg.ticker] = { scoringAt: new Date(scoringAt).toISOString(), aggregate: agg,
      scoringConfig: DEFAULT_SCORING_CONFIG, shadowConfig, vixQuote: opts.vixQuote ?? null, trackRecords };
    // Always persist the legacy flat-bonus score for A/B of the soft-mult model.
    // Optional shadowConfig knobs still produce an alternate score when set —
    // prefer explicit config shadow over legacy when both exist.
    const configShadow = shadowConfig ? scoreTicker(agg, shadowConfig, scoringAt).score : null;
    const shadowScore = configShadow ?? scored.legacyScore ?? null;
    return {
      ticker: scored.ticker,
      companyName: scored.companyName ?? null,
      score: scored.score,
      convictionLevel: scored.convictionLevel,
      totalDollarVolume: scored.totalDollarVolume,
      insiderCount: scored.insiderCount,
      topInsiderRole: scored.topInsiderRole,
      topInsiderName: scored.topInsiderName,
      optionsActivity: agg.options,
      rawTrades: agg.trades,
      breakdown: scored.breakdown,
      scrapedAt,
      sourceUrls: agg.sourceUrls,
      tradeDate: scored.tradeDate,
      filingDate: scored.filingDate,
      lateFiling: scored.lateFiling,
      comboSignal: scored.comboSignal,
      comboDetectedAt: scored.comboSignal ? scrapedAt : null,
      earningsDate: agg.earningsDate ?? null,
      earningsTiming: agg.earningsTiming ?? null,
      daysToEarnings: agg.daysToEarnings ?? null,
      bigPlayer: isBigPlayerByCap(scored.ticker, agg.marketCap),
      sector: agg.sector ?? null,
      shadowScore,
      // Display context — plumbed onto the signal so the card/breakdown can show
      // structured net-flow and equity-stats, not just the scoring notes.
      insiderFlow: agg.insiderFlow ?? null,
      stats: agg.stats ?? null,
      // Congressional leg — score + the trades, for display + combo badges.
      politicianScore: scored.politicianScore,
      politicianTrades: agg.politicianTrades ?? [],
    };
  });
  /**
   * A "signal" with nothing in it is not a signal.
   *
   * `buildAggregates` gates on an insider buy OR a whale-sized options print,
   * but the congressional merge below it pushes an aggregate for EVERY ticker
   * with any congressional buy in 90 days — and the live politician score
   * returns 0 for a lone print. The result was a stored row with no eligible
   * insider trade, no options and no score contribution: 3,946 of 10,541 rows
   * (37%) in the live database, mega-cap-heavy, occupying the entire bottom of
   * the score range and dragging the whole calibration with them.
   *
   * A ticker still surfaces on a single congressional print as soon as anything
   * else corroborates it (a cluster, an insider buy, options flow) — that is
   * exactly when `politicianScore` becomes non-zero.
   */
  const hasSignalContent = (s: Signal): boolean =>
    (s.breakdown?.rankWeight ?? 0) > 0 ||
    (s.optionsActivity?.length ?? 0) > 0 ||
    (s.politicianScore ?? 0) > 0;
  const contentless = signals.filter((s) => !hasSignalContent(s)).length;
  if (contentless > 0) {
    console.log(`[scraper] dropped ${contentless} content-free aggregate(s) (no insider leg, no options, no politician score)`);
  }
  signals = signals.filter(hasSignalContent);
  signals.sort((a, b) => b.score - a.score);

  // Persist — surface DB failures (e.g. schema mismatch) instead of silently
  // dropping every signal, which previously looked like "0 signals found".
  let persisted = false;
  if (signals.length) {
    try {
      insertSignals(signals, decisionContexts);
      persisted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[scraper] insertSignals failed:', message);
      errors.push({ source: 'database', message: `Failed to write ${signals.length} signals: ${message}` });
    }
  }

  // Keep the append-only history bounded (best-effort; never fails the scrape).
  try {
    pruneOldData();
  } catch (err) {
    console.error('[scraper] pruneOldData failed:', err);
  }

  const newHighConviction = signals
    .filter((s) => s.convictionLevel === 'HIGH' && !previousHigh.has(s.ticker))
    .map((s) => s.ticker);
  // Classic COMBO, MEGA, POLITICIAN_INSIDER, POLITICIAN_OPTIONS — any new multi-leg alignment.
  const newCombos = signals
    .filter((s) => {
      const isCombo = !!(s.comboSignal || s.breakdown?.politicianComboTier);
      return isCombo && !previousCombo.has(s.ticker);
    })
    .map((s) => s.ticker);
  // Feature 9 — sharp score jumps vs the previous session (more actionable than
  // absolute thresholds, especially as scores saturate near the top).
  const scoreSurges = signals
    .filter((s) => {
      const prev = previousScores.get(s.ticker);
      return prev != null && s.score - prev >= SCORE_SURGE_DELTA && s.score >= CONVICTION_THRESHOLDS.watch;
    })
    .map((s) => ({ ticker: s.ticker, from: previousScores.get(s.ticker) as number, to: s.score }));

  const signalsFound = persisted ? signals.length : 0;
  // Classify explicitly: a persist failure means nothing was saved (failed) no
  // matter how many sources ran; pipeline warnings (earnings/track-record/
  // valuation) alone must not mark a productive scrape as failed.
  const persistFailed = errors.some((e) => e.source === 'database');
  const trackedKeys = new Set([...enabled.map((s) => s.key), ...SIDE_KEYS]);
  // Per-source status: prefer explicit scrape status (-1 fail / N rows) over
  // counting only successful pushes (which hid timeouts as empty success).
  const sourceBreakdown: Record<string, number> = {};
  for (const src of enabled) {
    sourceBreakdown[src.key] =
      mainSourceCounts[src.key] !== undefined ? mainSourceCounts[src.key] : 0;
  }
  for (const key of SIDE_KEYS) {
    sourceBreakdown[key] = sideCounts[key] ?? 0;
  }

  // Metrics sanity: breakdown counts must match rows actually pushed into the
  // scrape arrays (pre-dedup). A shadowed/miswired counter (v1.0.46 all-zero
  // breakdown while trades still landed) trips this immediately.
  try {
    const scrapedBySource: Record<string, number> = {};
    for (const t of allTrades) {
      scrapedBySource[t.source] = (scrapedBySource[t.source] || 0) + 1;
    }
    for (const o of allOptions) {
      scrapedBySource[o.source] = (scrapedBySource[o.source] || 0) + 1;
    }
    for (const src of enabled) {
      const reported = sourceBreakdown[src.key];
      if (typeof reported !== 'number' || reported < 0) continue; // hard-fail sentinel
      const actual = (scrapedBySource[src.key] || 0) + (quality[src.key]?.badTicker ?? 0);
      if (reported !== actual) {
        const msg = `[scrape-metrics] sourceBreakdown mismatch for ${src.key}: breakdown=${reported} scrapedRows=${actual}`;
        console.error(msg);
        errors.push({ source: 'metrics', message: msg });
      }
    }
  } catch (err) {
    console.error('[scrape-metrics] consistency check failed:', err);
  }

  // Data-quality summary — logged and printed, so a source that silently starts
  // returning unusable rows shows up as a number instead of as a mystery.
  const dataQuality: DataQualityReport = quality;
  for (const [key, q] of Object.entries(dataQuality)) {
    const dropped = q.badTicker + q.badDate + q.noValue;
    if (q.rows > 0 && dropped / q.rows >= 0.2) {
      console.warn(
        `[data-quality] ${key}: ${dropped}/${q.rows} rows unusable ` +
          `(ticker ${q.badTicker}, date ${q.badDate}, value ${q.noValue}, unknown type ${q.unknownType})`,
      );
    }
    // A repair rate this high means the SOURCE is corrupting symbols, not that
    // the registry is being clever — it should be fixed upstream, not papered over.
    if (q.rows > 0 && q.repairedTicker / q.rows >= 0.05) {
      console.warn(
        `[data-quality] ${key}: repaired ${q.repairedTicker}/${q.rows} doubled-first-letter ticker(s) — ` +
          'the source is rendering a logo glyph into the symbol cell',
      );
    }
  }

  const sourceErrorCount = new Set(errors.filter((e) => trackedKeys.has(e.source)).map((e) => e.source)).size;
  const status: ScrapeResult['status'] = persistFailed
    ? 'failed'
    : errors.length === 0
      ? 'success'
      : sourceErrorCount < trackedKeys.size
        ? 'partial'
        : 'failed';

  finishScrapeLog(logId, {
    signalsFound,
    status,
    sourcesScraped: completed,
    vixAtScrape: vix ?? null,
    sourceBreakdown,
    dataQuality,
  });

  // Custom alert rules — crossing-style evaluation of the new session vs the
  // previous one (per-ticker / watchlist / global rules from Settings).
  let alertHits: ScrapeResult['alertHits'];
  try {
    const rules = getAlertRules();
    if (rules.some((r) => r.enabled)) {
      const hits = evaluateAlertRules(rules, signals, lastSession, getWatchlistTickers());
      if (hits.length) alertHits = hits;
    }
  } catch (err) {
    console.error('[scraper] alert rule evaluation failed:', err);
  }

  // Source health — detect silently-broken scrapers (healthy history, now zero
  // rows for consecutive runs). Includes the run just logged above.
  let sourceHealth: ScrapeResult['sourceHealth'];
  try {
    const issues = computeSourceHealth(
      [...enabled.map((s) => s.key), ...SIDE_KEYS],
      getRecentSourceBreakdowns(20),
    );
    if (issues.length) sourceHealth = issues;
  } catch (err) {
    console.error('[scraper] source health check failed:', err);
  }

  const finishedAt = new Date().toISOString();
  setStatus({
    running: false,
    phase: 'Done',
    currentSource: undefined,
    signalsFound,
    error: errors.length ? `${errors.length} issue(s): ${errors[0].message}` : undefined,
  });

  return {
    status,
    signalsFound,
    signals: persisted ? signals : [],
    sourcesScraped: completed,
    errors,
    newHighConviction,
    newCombos,
    scoreSurges,
    sourceHealth,
    alertHits,
    filingEvents: newFilingEvents.length ? newFilingEvents : undefined,
    startedAt,
    finishedAt,
  };
}
