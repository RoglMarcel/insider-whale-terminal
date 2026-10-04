import { utcInstantMs } from '../lib/utcDate';
/**
 * Shared types for both the Electron main process and the React renderer.
 * This file MUST stay dependency-free (pure TypeScript) so it can be imported
 * from either side without pulling in node-only or DOM-only modules.
 */

// ──────────────────────────────────────────────────────────────────────────
// Core domain primitives
// ──────────────────────────────────────────────────────────────────────────

export type ConvictionLevel = 'HIGH' | 'WATCH' | 'LOW';

/** SEC Form 4 transaction codes. P = open-market purchase, S = sale, etc. */
export type TransactionType = 'P' | 'S' | 'A' | 'D' | 'G' | 'M' | 'F' | 'C' | string;

export type ScraperSource =
  | 'edgar'
  | 'openinsider'
  | 'finviz'
  | 'secform4'
  | 'marketbeat'
  | 'insidermonitor'
  | 'quiverquant'
  | 'ceowatcher'
  | 'barchart'
  | 'optionstrat'
  | 'insiderfinance'
  | 'marketbeatoptions';

/**
 * A congressional (House/Senate) stock transaction disclosed under the STOCK
 * Act. A first-class signal source alongside insider Form 4 and options flow.
 */
export interface PoliticianTrade {
  id?: number;
  politician: string;
  chamber: 'House' | 'Senate';
  party: 'Democrat' | 'Republican' | 'Independent' | string;
  committee?: string;
  ticker: string;
  transactionType: 'buy' | 'sell';
  /** USD midpoint of the disclosed amount range. */
  amountMidpoint: number;
  tradeDate: string; // YYYY-MM-DD
  disclosureDate: string; // YYYY-MM-DD
  daysToDisclose: number | null;
  scrapedAt: string;
}

/** Politician combo tiers — congressional buying aligned with other signals. */
export type PoliticianComboTier = 'POLITICIAN_INSIDER' | 'POLITICIAN_OPTIONS' | 'MEGA_SIGNAL';

/** Normalized insider trade emitted by every insider scraper. */
export interface RawInsiderTrade {
  ticker: string;
  companyName?: string;
  insiderName: string;
  /** Raw role/title string as scraped (e.g. "Chief Executive Officer"). */
  role: string;
  transactionType: TransactionType;
  /** ISO date string (YYYY-MM-DD) of the trade (when the insider executed). */
  tradeDate: string;
  /** ISO date string of the SEC Form 4 filing, if available. */
  filingDate?: string;
  shares: number;
  price?: number;
  /** Absolute USD value of the transaction (always positive). */
  value: number;
  /** Source key, e.g. 'openinsider'. */
  source: ScraperSource;
  sourceUrl?: string;
  /** Feature 1 — true if filed > 4 business days after the trade (suspicious). */
  lateFiling?: boolean;
  /** Feature 6 — link to the insider's OpenInsider history page, when known. */
  insiderUrl?: string;
  /** Stable source transaction identity, independent of mutable amounts. */
  transactionId?: string;
  /** Explicit link supplied by the source to the original transaction ID. */
  revisionOf?: string;
  /** Source publication/revision instant; retrieval time is never version order. */
  revisionAt?: string;
  observedAt?: string;
  dateStatus?: 'valid' | 'unknown' | 'invalid' | 'future';
  integrityStatus?: 'revision-conflict' | 'unlinked-amendment' | 'ambiguous-overlap';
  /** A joint filing has one economic transaction, not one copy per reporting owner. */
  reportingOwners?: { cik: string; name: string; role: string }[];
  filingAccession?: string;
  issuerCik?: string;
  originalSubmissionDate?: string;
  securityTitle?: string;
  ownershipNature?: string;
  filingRow?: number;
  amendment?: boolean;
}

/** Normalized unusual-options event emitted by every options scraper. */
export interface OptionsActivity {
  ticker: string;
  type: 'call' | 'put';
  sentiment: 'bullish' | 'bearish';
  /** USD notional / total premium of the sweep/block. */
  notional: number;
  strike?: number;
  /** ISO date string of expiry. */
  expiry?: string;
  volume?: number;
  openInterest?: number;
  source: ScraperSource;
  sourceUrl?: string;
  // ── Feature 3 — options-specific detail ──
  /** Days to expiration from the trade date. */
  dte?: number;
  /** Underlying price at the time of the trade. */
  currentPrice?: number;
  /** Signed % out-of-the-money: positive = OTM, negative = ITM, for both calls and puts. */
  otmPercent?: number;
  /** True if the order swept multiple exchanges. */
  isSweep?: boolean;
  /** volume / open_interest. */
  volOiRatio?: number;
  /** Total dollar premium paid (alias of notional when present). */
  premiumTotal?: number;
  /** ISO timestamp when first scraped (for temporal merging). */
  scrapedAt?: string;
  /** Actual event time if reported by the provider; never synthesized from retrieval. */
  eventAt?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Scoring
// ──────────────────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  /** Step 1 — highest insider rank weight on the ticker (1–10). */
  rankWeight: number;
  /** Step 2 — dollar-volume points from total eligible buy volume (1–20). */
  dollarVolumePoints: number;
  /** Feature 2 — value-weighted transaction-type modifier (0–1). */
  typeModifier: number;
  /** Step 3 — cluster multiplier from distinct insiders (1.0–3.0). */
  clusterMultiplier: number;
  /** Feature 5 — insider earnings-timing multiplier (1.0–2.34). */
  timingMultiplier: number;
  /** Feature 3 — detailed options score (signed; negative for net bearish). */
  optionsScore: number;
  /** Feature 5 — options earnings-timing multiplier (1.0–2.0). */
  optionsTimingMultiplier: number;
  /** Feature 1 — freshness/time-decay multiplier (0.15–1.0). */
  freshnessMultiplier: number;
  /** Feature 8 — VIX fear multiplier on insider buying (1.0 or 1.15). */
  vixMultiplier: number;
  /** Feature 6 — best-insider track-record multiplier (0.85–1.2). */
  trackRecordMultiplier: number;
  /**
   * Feature 10 - fair-value multiplier (0.9-1.15). It is applied to the
   * COMPOSITE, so a breakdown without it cannot reproduce its own rawScore.
   * Historical rows written while a fair-value provider was live omit it; the
   * re-score derives it from the residual for exactly that reason.
   */
  valuationMultiplier: number;
  /** Versioned valuation snapshot, persisted with the score breakdown. */
  fairValue?: import('./fairValue').FairValueResult;
  /** Feature 4 — flat combo bonus added post-normalization (0 or 30). */
  comboBonus: number;
  /** Back-compat alias of optionsScore for older UI paths. */
  optionsBonus: number;
  /** Feature 1 — age (days) of the freshest eligible buy, for display. */
  signalAgeDays: number | null;
  /** Composite raw score before normalization. */
  rawScore: number;
  /** Theoretical maximum raw score, used for normalization. */
  maxPossibleRaw: number;
  /** Final 0–100 score. */
  normalizedScore: number;
  /**
   * Data confidence 0–100 — how much the system actually KNOWS about this
   * signal (field completeness + cross-source corroboration + authoritative
   * sourcing). Two equal scores are not equal when one is a single-aggregator
   * estimate and the other is EDGAR-corroborated with full enrichment.
   */
  confidence?: number;
  /** Congressional trading leg — raw politician score folded into the composite. */
  politicianScore?: number;
  /** Which politician-combo tier fired (or null). */
  politicianComboTier?: PoliticianComboTier | null;
  /**
   * Factors that returned their NEUTRAL value because their input was missing,
   * not because the data said "neutral".
   *
   * `docs/audit/FACTORS.md` measured `vixMultiplier`, `valuationMultiplier` and
   * `comboBonus` at 0.0% of score variance. That is not evidence against them —
   * it is evidence that they never fired, and a ×1.0 that means "VIX unknown"
   * had been indistinguishable from a ×1.0 that means "VIX is calm". Listing
   * them makes a dead knob visible instead of silent, which is the difference
   * between a factor that is dormant and a factor that is broken.
   *
   * Cosmetic only: nothing here changes a score.
   */
  dormantFactors?: DormantFactor[];
  /** Human-readable notes about which bonuses applied. */
  notes: string[];
}

/** Why a factor could not act. One entry per dormant factor. */
export interface DormantFactor {
  /** Breakdown field name, e.g. `vixMultiplier`. */
  factor: string;
  /** The missing input or blocking gate, in one short phrase. */
  reason: string;
}

/** A scored, persisted signal for a single ticker. */
export interface Signal {
  id?: number;
  ticker: string;
  companyName?: string | null;
  score: number;
  convictionLevel: ConvictionLevel;
  totalDollarVolume: number;
  insiderCount: number;
  topInsiderRole: string | null;
  topInsiderName?: string | null;
  optionsActivity: OptionsActivity[];
  rawTrades: RawInsiderTrade[];
  breakdown: ScoreBreakdown;
  /** ISO datetime of the scrape that produced this signal. */
  scrapedAt: string;
  /** Score under the shadow (A/B) config, when one is active. */
  shadowScore?: number | null;
  sourceUrls: string[];
  // ── Feature 1 — representative dates (freshest eligible buy) ──
  tradeDate?: string | null;
  filingDate?: string | null;
  lateFiling?: boolean;
  // ── Feature 4 — combo ──
  comboSignal?: boolean;
  comboDetectedAt?: string | null;
  // ── Feature 5 — earnings ──
  earningsDate?: string | null;
  earningsTiming?: string | null;
  daysToEarnings?: number | null;
  bigPlayer?: boolean;
  /** Feature 6 — sector/industry classification, when known. */
  sector?: string | null;
  /** Sell-side context — trailing-90d same-company insider flow (display only). */
  insiderFlow?: InsiderFlowSummary | null;
  /** Equity stats pack — short interest / float / liquidity / 52w drawdown (display only). */
  stats?: EquityStatsSummary | null;
  /** Congressional trading leg — raw politician score contributed to the composite. */
  politicianScore?: number;
  /** Recent congressional trades on this ticker (display + combo detection). */
  politicianTrades?: PoliticianTrade[];
}

/** Trailing-window insider buy/sell dollar totals + Form 144 notice count. */
export interface InsiderFlowSummary {
  buys: number;
  sells: number;
  form144: number;
  unresolvedBuys?: number;
  buyCoverage?: 'dated-records';
}

/** Squeeze context, tradeability, and price context for a ticker. */
export interface EquityStatsSummary {
  shortPctFloat?: number;
  floatShares?: number;
  avgDollarVolume?: number;
  /** Distance from the 52-week high, ≤ 0 (e.g. −34.2 = 34% below the high). */
  pctFrom52wHigh?: number;
}

/** Aggregated per-ticker input that feeds the scoring function. */
export interface TickerAggregate {
  ticker: string;
  companyName?: string;
  trades: RawInsiderTrade[];
  options: OptionsActivity[];
  /** Feature 5 — days until next earnings (enables the timing bonus). */
  daysToEarnings?: number;
  earningsDate?: string;
  earningsTiming?: string;
  /** Feature 8 — VIX at scrape time (boosts insider buys when > 25). */
  vix?: number;
  /** Feature 6 — best cached insider accuracy_3m for this ticker (0–1). */
  bestAccuracy3m?: number;
  /** Market cap (USD) when known — normalizes buy size by company size. */
  marketCap?: number;
  /**
   * Legacy fair-value upside input. New live valuations use the structured snapshot.
   */
  upsidePct?: number;
  fairValue?: import('./fairValue').FairValueResult;
  /** Feature 6 — sector/industry, when known. */
  sector?: string;
  /**
   * Sell-side context — trailing-90d same-company insider flow (buy/sell
   * dollar totals + Form 144 proposed-sale notices). Display/notes only; not a
   * score input until backtested.
   */
  insiderFlow?: InsiderFlowSummary;
  /**
   * Equity stats pack — squeeze context, tradeability, and price context
   * (drawdown from the 52-week high, ≤ 0). Display/notes only; not a score
   * input until backtested.
   */
  stats?: { shortPctFloat?: number; floatShares?: number; avgDollarVolume?: number; pctFrom52wHigh?: number };
  /** Recent SC 13D/13G filings on this ticker (90d window; display/notes only). */
  filingEvents?: FilingEvent[];
  /** Distinct scraper sources that reported this ticker (pre-dedup corroboration). */
  sourceCount?: number;
  /** Congressional trades on this ticker (last 90 days), merged in by the orchestrator. */
  politicianTrades?: PoliticianTrade[];
  sourceUrls: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Insider track record (Features 6 + 9)
// ──────────────────────────────────────────────────────────────────────────

export interface InsiderHistoricalTrade {
  tradeDate: string;
  ticker: string;
  transactionType: string;
  shares?: number;
  value?: number;
  /** Raw price the insider paid (for display). */
  purchasePrice?: number;
  /** Split/dividend-adjusted price ~3 / ~6 months after the trade. */
  price3mLater?: number;
  price6mLater?: number;
  /** ~3-month return IN EXCESS of the S&P 500 (alpha), split/dividend-adjusted. */
  return3m?: number;
  /** True if the trade BEAT the S&P 500 over ~3 / ~6 months. */
  wasProfitable3m?: boolean;
  wasProfitable6m?: boolean;
}

/**
 * Calendar-pattern classification (Cohen–Malloy–Pomorski, "Decoding Inside
 * Information"): insiders whose purchases cluster in the same calendar month
 * across years are ROUTINE (scheduled/habitual — little information); a
 * first-ever open-market buy is OPPORTUNISTIC (where the alpha lives). Mixed
 * histories make no claim (null). Display-only until backtested.
 */
export type InsiderPattern = 'routine' | 'opportunistic';

export function classifyInsiderPattern(purchaseDates: readonly string[]): InsiderPattern | null {
  const months: number[] = [];
  const years = new Set<number>();
  for (const d of purchaseDates) {
    const m = /^(\d{4})-(\d{2})/.exec(d ?? '');
    if (!m) continue;
    years.add(Number(m[1]));
    months.push(Number(m[2]));
  }
  const n = months.length;
  if (n === 0) return null;
  if (n === 1) return 'opportunistic'; // first-ever open-market buy
  if (n >= 3 && years.size >= 2) {
    const counts = new Map<number, number>();
    for (const mo of months) counts.set(mo, (counts.get(mo) ?? 0) + 1);
    // ≥60% of all purchases in one calendar month, across multiple years =
    // scheduled/habitual buying (a within-one-year cluster does NOT qualify).
    if (Math.max(...counts.values()) / n >= 0.6) return 'routine';
  }
  return null;
}

export interface InsiderTrackRecord {
  insiderName: string;
  insiderRole?: string | null;
  totalTrades: number;
  /** Count of trades that beat the S&P 500 over ~3 / ~6 months. */
  profitable3m: number;
  profitable6m: number;
  /** Share of trades that beat the market over ~3 months (0–1). */
  accuracy3m: number;
  accuracy6m: number;
  /** Average ~3-month return vs the S&P 500 (alpha), in percent. */
  avgReturn3m: number;
  lastUpdated: string;
  /** Most recent historical trades (for the sparkline + popover). */
  recentTrades: InsiderHistoricalTrade[];
  /** Calendar-pattern classification (see classifyInsiderPattern). */
  pattern?: InsiderPattern | null;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// VIX (Feature 8)
// ──────────────────────────────────────────────────────────────────────────

export interface VixQuote {
  value: number;
  level: 'low' | 'normal' | 'high';
  timestamp: string;
}

/** "Follow this signal" P&L since a ticker first appeared as a signal. */
export interface SignalPerformance {
  ticker: string;
  /** Date the signal entry is measured from (first trade/scrape date). */
  sinceDate: string;
  entryPrice?: number;
  currentPrice?: number;
  /** Split/dividend-adjusted return since the entry date, in percent. */
  returnPct?: number;
  /** Return in excess of the S&P 500 over the same window (alpha). */
  alphaPct?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Dashboard filtering (Feature 7)
// ──────────────────────────────────────────────────────────────────────────

export type TimeRange = '24h' | '48h' | 'week' | 'all';
export type TypeFilter = 'all' | 'openmarket' | 'options' | 'combo';
export type ConvictionFilter = 'all' | 'HIGH' | 'WATCH';
export type SortKey = 'score' | 'confidence';

export interface SignalFilter {
  timeRange: TimeRange;
  type: TypeFilter;
  conviction: ConvictionFilter;
  bigPlayersOnly: boolean;
  /** Dashboard sort: raw conviction score or data-confidence. */
  sortBy?: SortKey;
  /**
   * Free-text query over ticker / company / insider name. Part of the filter (not
   * Dashboard-local state) so the stat cards describe the same set the grid shows —
   * otherwise the header reported "12 on watch" while a search left none visible.
   */
  search?: string;
}

// Default to "This Week", not 48h: insider Form 4 *trade* dates lag the *filing*
// (and our scrape) by several days, so a 48h-on-trade-date window is almost
// always empty and makes a freshly-scraped dashboard look broken. Week shows the
// recent batch; the 48h / Today buttons remain for narrowing.
export const DEFAULT_FILTER: SignalFilter = {
  timeRange: 'week',
  type: 'all',
  conviction: 'all',
  bigPlayersOnly: false,
  sortBy: 'score',
};

// ──────────────────────────────────────────────────────────────────────────
// Watchlist / history / logs
// ──────────────────────────────────────────────────────────────────────────

export interface WatchlistItem {
  id?: number;
  ticker: string;
  addedAt: string;
  notes?: string | null;
  /** Most recent signal for this ticker, joined for the live score badge. */
  signal?: Signal | null;
}

/**
 * Per-source data-quality counters for one run. `sourceBreakdown` answers "how
 * many rows did this source produce"; this answers "how many of them were
 * usable". A source whose ticker column moves keeps producing rows and looks
 * healthy in the breakdown while the pipeline silently throws every row away —
 * that gap is exactly what these numbers make visible.
 */
export interface DataQualityStat {
  /** Rows the source returned, before any gate. */
  rows: number;
  /** Dropped because the "ticker" was not a symbol (see isValidTicker). */
  badTicker: number;
  /** Symbols whose doubled first letter was repaired against the SEC registry. */
  repairedTicker: number;
  /** Rows whose trade date did not parse into YYYY-MM-DD. */
  badDate: number;
  /** Rows with no usable dollar value / premium. */
  noValue: number;
  /** Rows whose transaction type classified as Unknown (modifier 0). */
  unknownType: number;
  /** Rows with no insider role/title at all. */
  noRole: number;
}

export type DataQualityReport = Record<string, DataQualityStat>;

/** Share of a source's rows that the pipeline could not use (0–1). */
export function dropRate(stat: DataQualityStat): number {
  if (!stat || stat.rows <= 0) return 0;
  return Math.min(1, (stat.badTicker + stat.badDate + stat.noValue) / stat.rows);
}

/** Share of a source's rows whose symbol had to be repaired (0–1). */
export function repairRate(stat: DataQualityStat): number {
  if (!stat || stat.rows <= 0) return 0;
  return Math.min(1, (stat.repairedTicker ?? 0) / stat.rows);
}

export interface ScrapeLogEntry {
  id?: number;
  startedAt: string;
  finishedAt?: string | null;
  sourcesScraped: string[];
  signalsFound: number;
  status: 'success' | 'partial' | 'failed';
  /** Feature 8 — VIX captured at scrape time. */
  vixAtScrape?: number | null;
  sourceBreakdown?: Record<string, number> | null;
  /** Per-source usability counters for this run (see DataQualityStat). */
  dataQuality?: DataQualityReport | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Scraper status / results
// ──────────────────────────────────────────────────────────────────────────

export interface ScrapeStatus {
  running: boolean;
  phase: string;
  currentSource?: string;
  completedSources: string[];
  totalSources: number;
  signalsFound: number;
  startedAt?: string;
  error?: string;
}

export interface ScrapeError {
  source: string;
  message: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Activist / large-holder filings (SC 13D / 13G radar)
// ──────────────────────────────────────────────────────────────────────────

export interface FilingEvent {
  ticker: string;
  /** e.g. 'SC 13D', 'SC 13D/A', 'SC 13G'. */
  type: string;
  /** Reporting person / fund, when resolvable from the filing feed. */
  filer: string | null;
  filedDate: string; // YYYY-MM-DD
  url: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Performance dashboard (calibration report)
// ──────────────────────────────────────────────────────────────────────────

export interface PerformanceTierStats {
  tier: string;
  n: number;
  /** Share of observations with positive 10-day alpha vs SPY. */
  winRate10: number;
  avgAlpha10: number;
  avgAlpha20: number;
}

export interface PerformanceBucketStats {
  label: string;
  n: number;
  avgAlpha10: number;
}

/** Realized-outcome calibration of stored signals (F31 dedup, SPY-relative). */
export interface PerformanceReport {
  ranAt: string;
  fromDate: string | null;
  toDate: string | null;
  nObservations: number;
  tiers: PerformanceTierStats[];
  buckets: PerformanceBucketStats[];
  /** Spearman rank correlation between score and 10-day alpha. */
  ic10: number | null;
  note?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Custom alert rules — pure evaluation, shared by main (post-scrape) + UI
// ──────────────────────────────────────────────────────────────────────────

export type AlertScope = 'ticker' | 'watchlist' | 'global';
export type AlertCondition = 'score_gte' | 'new_insider_buy' | 'new_combo' | 'cluster_gte';

export interface AlertRule {
  id?: number;
  scope: AlertScope;
  /** Required when scope = 'ticker'. */
  ticker?: string | null;
  condition: AlertCondition;
  /** score for score_gte; insider count for cluster_gte; unused otherwise. */
  threshold?: number | null;
  enabled: boolean;
  createdAt?: string;
}

export interface AlertHit {
  ruleId: number;
  ticker: string;
  message: string;
}

export const ALERT_CONDITION_LABELS: Record<AlertCondition, string> = {
  score_gte: 'Score crosses threshold',
  new_insider_buy: 'Any new insider buy',
  new_combo: 'New combo signal',
  cluster_gte: 'Insider cluster reaches N',
};

/**
 * Evaluate alert rules against the new scrape session, CROSSING-style: a rule
 * fires when its condition became true this session vs the previous one, not
 * while it merely stays true. Cold start (no previous session at all) fires
 * nothing — otherwise a fresh install floods one alert per signal.
 */
export function evaluateAlertRules(
  rules: readonly AlertRule[],
  current: readonly Signal[],
  previous: readonly Signal[],
  watchlistTickers: readonly string[],
): AlertHit[] {
  if (previous.length === 0) return [];
  const prevByTicker = new Map(previous.map((s) => [s.ticker, s]));
  const watch = new Set(watchlistTickers.map((t) => t.toUpperCase()));
  const hits: AlertHit[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.id == null) continue;
    const scoped = current.filter((s) => {
      if (rule.scope === 'ticker') return s.ticker === (rule.ticker ?? '').trim().toUpperCase();
      if (rule.scope === 'watchlist') return watch.has(s.ticker);
      return true;
    });
    for (const s of scoped) {
      const prev = prevByTicker.get(s.ticker);
      switch (rule.condition) {
        case 'score_gte': {
          const th = rule.threshold ?? 80;
          if (s.score >= th && (!prev || prev.score < th)) {
            hits.push({ ruleId: rule.id, ticker: s.ticker, message: `${s.ticker} score crossed ${th} (now ${s.score.toFixed(0)})` });
          }
          break;
        }
        case 'new_insider_buy': {
          const newer = !prev || (s.tradeDate ?? '') > (prev.tradeDate ?? '') || s.insiderCount > prev.insiderCount;
          if (newer && s.insiderCount > 0) {
            hits.push({
              ruleId: rule.id,
              ticker: s.ticker,
              message: `New insider buying on ${s.ticker} (${s.insiderCount} insider(s), score ${s.score.toFixed(0)})`,
            });
          }
          break;
        }
        case 'new_combo': {
          if (s.comboSignal && !prev?.comboSignal) {
            hits.push({ ruleId: rule.id, ticker: s.ticker, message: `New combo signal on ${s.ticker} (score ${s.score.toFixed(0)})` });
          }
          break;
        }
        case 'cluster_gte': {
          const th = rule.threshold ?? 3;
          if (s.insiderCount >= th && (!prev || prev.insiderCount < th)) {
            hits.push({ ruleId: rule.id, ticker: s.ticker, message: `${s.ticker} insider cluster reached ${s.insiderCount} (rule: ≥${th})` });
          }
          break;
        }
      }
    }
  }
  return hits;
}

// ──────────────────────────────────────────────────────────────────────────
// Source health (silent-rot detection) — pure, shared
// ──────────────────────────────────────────────────────────────────────────

export interface SourceHealthIssue {
  source: string;
  /** How many consecutive most-recent runs returned zero rows. */
  consecutiveZeroRuns: number;
  /** Rolling median row count for this source over the inspected window. */
  rollingMedian: number;
  /** Total zero-row runs in the inspected window (not necessarily consecutive). */
  zeroRunsInWindow?: number;
  /** Runs inspected, so a caller can render "3 of 11 runs". */
  runsInWindow?: number;
  /** `dead` = zero run after run; `flapping` = intermittent but recovering. */
  kind?: 'dead' | 'flapping';
}

/**
 * Detect silently-broken sources: every scraper fails soft (empty array), so a
 * site redesign shows up ONLY as a source that used to produce rows suddenly
 * producing zero, run after run. A source is flagged when it has a healthy
 * history (median > 0 over ≥ 4 participating runs) but returned 0 rows in the
 * 2+ most recent consecutive runs. Chronically-empty sources are never flagged.
 *
 * A source can also fail INTERMITTENTLY — zero rows on one run, healthy on the
 * next — which the consecutive-runs rule can never catch, because the streak
 * resets every time. That pattern is not cosmetic: each zero run drops every
 * signal the source was carrying, so it is reported as `flapping` once a
 * healthy source has ≥ 2 zero runs across the inspected window.
 *
 * @param runsNewestFirst per-run `sourceBreakdown` maps, most recent first.
 */
export function computeSourceHealth(
  enabledKeys: readonly string[],
  runsNewestFirst: readonly Record<string, number>[],
): SourceHealthIssue[] {
  const issues: SourceHealthIssue[] = [];
  for (const key of enabledKeys) {
    // Only runs in which this source actually participated.
    // Counts may be negative: sentinel for hard failure (timeout / all layers failed).
    const counts = runsNewestFirst
      .map((run) => run[key])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (counts.length < 2) continue;
    // Normalize failure sentinel (-1) to 0 for median/zero-run math.
    const norm = counts.map((c) => (c < 0 ? 0 : c));
    const sorted = [...norm].sort((a, b) => a - b);
    const rollingMedian = sorted[Math.floor(sorted.length / 2)];
    let consecutiveZeroRuns = 0;
    for (const c of norm) {
      if (c === 0) consecutiveZeroRuns++;
      else break;
    }
    const zeroRunsInWindow = norm.filter((c) => c === 0).length;
    const base = {
      source: key,
      consecutiveZeroRuns,
      rollingMedian: Math.max(rollingMedian, 0),
      zeroRunsInWindow,
      runsInWindow: counts.length,
    };
    if (consecutiveZeroRuns >= 2) {
      // (a) Healthy history then zero — need ≥4 participating runs (stable median).
      // (b) Hard-fail sentinel (−1) twice in a row — flag immediately (not silent empty).
      const recentHardFails = counts.slice(0, consecutiveZeroRuns).filter((c) => c < 0).length;
      const healthyThenDead = counts.length >= 4 && norm.some(c => c > 0);
      const hardFailDead = recentHardFails >= 2;
      if (healthyThenDead || hardFailDead) {
        issues.push({ ...base, kind: 'dead' });
        continue;
      }
    }
    // Intermittent: recovers between runs, so the streak never reaches 2, but
    // every zero run still blanks the signals this source carries.
    if (counts.length >= 6 && rollingMedian > 0 && zeroRunsInWindow >= 2) {
      issues.push({ ...base, kind: 'flapping' });
    }
  }
  return issues;
}

export type SourceStatus = 'healthy' | 'degraded' | 'dead' | 'flapping' | 'unknown';

/**
 * Turn one source's history into the badge the UI shows — and, because only
 * `dead` fires the red "broken" banner, into the decision of whether to alarm.
 *
 * This lived inline in `useSourceHealth` and got it wrong. It gated the
 * `flapping` branch on "the newest run did not fail", which is unsatisfiable
 * for the sources flapping is *for*: one that fails intermittently eventually
 * has a failure as its newest run, and every time it did, it was reported dead.
 * Measured 2026-08-31 — OpenInsider returned 338–415 rows in 10 of its last 12
 * runs and still showed as broken, under a banner claiming "zero rows for
 * multiple consecutive scrapes" that its own history contradicts.
 *
 * The rule: `computeSourceHealth` has already weighed the whole window, so its
 * verdict wins. A single hard failure is `degraded`, never `dead` — two in a
 * row make it `dead`, and that is `computeSourceHealth`'s call to make.
 *
 * @param issue  what `computeSourceHealth` concluded for this source, if anything
 * @param counts this source's row counts, newest first, −1 for a hard failure
 */
export function sourceStatus(issue: SourceHealthIssue | undefined, counts: readonly number[]): SourceStatus {
  if (counts.length === 0) return 'unknown';
  const norm = counts.map((c) => (c < 0 ? 0 : c));
  const sorted = [...norm].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (issue?.kind === 'flapping') return 'flapping';
  if (issue) return 'dead';
  if (counts[0] < 0) return 'degraded';
  if (norm.every(c => c === 0)) return 'unknown';
  if (norm.some(c => c > 0) && norm[0] === 0) return 'degraded';
  return 'healthy';
}

export interface ScrapeResult {
  status: 'success' | 'partial' | 'failed';
  signalsFound: number;
  signals: Signal[];
  sourcesScraped: string[];
  errors: ScrapeError[];
  /** Tickers that newly crossed into HIGH conviction this session. */
  newHighConviction: string[];
  /** Feature 4 — tickers that are new combo signals this session. */
  newCombos: string[];
  /** Feature 9 — tickers whose score jumped sharply vs the previous session. */
  scoreSurges: { ticker: string; from: number; to: number }[];
  /** Sources that look silently broken (healthy history, now zero rows). */
  sourceHealth?: SourceHealthIssue[];
  /** Custom alert rules that fired this session. */
  alertHits?: AlertHit[];
  /** SC 13D/13G filings first seen this session. */
  filingEvents?: FilingEvent[];
  startedAt: string;
  finishedAt: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Settings
// ──────────────────────────────────────────────────────────────────────────

export interface AppSettings {
  scheduleEnabled: boolean;
  scheduleTimes: {
    marketOpen: boolean; // 9:30 AM EST
    midday: boolean; // 12:00 PM EST
    close: boolean; // 4:00 PM EST
  };
  /** Score at/above which a desktop notification fires. */
  notificationThreshold: number;
  /** Minimum total dollar volume for a ticker to be scored/shown. */
  minDollarVolume: number;
  /** Per role-category include toggle (keys from ROLE_CATEGORIES). */
  roleFilters: Record<string, boolean>;
  /** Per-source enable toggle. */
  sources: Record<ScraperSource, boolean>;
  /** Run Chromium headless (true in production by default). */
  headless: boolean;
  /**
   * Push each desktop scrape's signals into the web terminal's repo DB and let
   * CI redeploy the site. Off means the run stays on this machine only.
   */
  webPublishEnabled: boolean;
  /**
   * Absolute path to the repo checkout that backs the website. Required for the
   * PACKAGED app, which runs from Program Files and cannot infer it; when
   * running from source the working directory is used instead.
   */
  webPublishRepoPath: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Transaction-type classification (Feature 2) — pure, shared by main + renderer
// ──────────────────────────────────────────────────────────────────────────

export type TxTier = 'strong' | 'reduced' | 'excluded';

export interface TxClassification {
  modifier: number;
  label: string;
  tier: TxTier;
}

/**
 * Classify a raw transaction-type string into a scoring modifier + display tier.
 * Handles SEC codes (first char) and the descriptive strings sources emit.
 */
export function classifyTransaction(raw: string): TxClassification {
  const s = (raw ?? '').toLowerCase().trim();
  /**
   * The SEC transaction CODE — only when the string actually IS a code, i.e. a
   * bare letter ("P") or a letter followed by a separator ("P - Purchase",
   * "S/Sale", "A: Award"). Taking `s.charAt(0)` unconditionally applied the code
   * table to arbitrary prose and misread real events:
   *   "Acquisition"   → 'a' → Stock Award,           modifier 0 (a BUY, dropped)
   *   "Automatic Buy" → 'a' → Stock Award,           modifier 0 (a BUY, dropped)
   *   "Cash Purchase" → 'c' → Derivative Conversion, modifier 0.2
   *   "Common Stock"  → 'c' → Derivative Conversion, modifier 0.2
   *   "Dir"           → 'd' → Sale,                  modifier 0
   * All four transaction-type strings present in the live database
   * ("P - Purchase", "Buy", "Purchase", "Purchase(A)") classify identically
   * before and after this change, so nothing in the stored history moves.
   */
  const code = /^[a-z]([^a-z].*)?$/.test(s) ? s.charAt(0) : '';
  const has = (...t: string[]) => t.some((x) => s.includes(x));

  // 10b5-1 pre-scheduled plans. "automatic" belongs here: it is the wording
  // Insider-Monitor's AB/AS codes expand to, and a plan trade carries little
  // information regardless of which word a source uses for it.
  if (has('10b5-1', '10b5', 'planned', 'automatic')) {
    if (has('sale', 'sell', 'dispos')) return { modifier: 0.0, label: '10b5-1 Sale', tier: 'excluded' };
    return { modifier: 0.4, label: '10b5-1 Buy', tier: 'reduced' };
  }
  // Option exercise (SEC code M / "exercise" / openinsider "+OE")
  if (has('exercise', '+oe') || code === 'm') {
    if (has('sale', 'sell', '+s', 'dispos')) return { modifier: 0.0, label: 'Exercise + Sale', tier: 'excluded' };
    return { modifier: 0.5, label: 'Exercise + Hold', tier: 'reduced' };
  }
  // Gift (SEC code G)
  if (has('gift') || code === 'g') {
    if (has('given', 'dispos')) return { modifier: 0.0, label: 'Gift Given', tier: 'excluded' };
    return { modifier: 0.1, label: 'Gift Received', tier: 'reduced' };
  }
  // Award / RSU / vest / grant (SEC code A)
  if (has('award', 'rsu', 'vest', 'grant') || code === 'a') {
    return { modifier: 0.0, label: 'Stock Award', tier: 'excluded' };
  }
  // Conversion of derivative (SEC code C)
  if (has('conversion', 'convert') || code === 'c') {
    return { modifier: 0.2, label: 'Derivative Conversion', tier: 'reduced' };
  }
  // Sale / disposition (SEC codes S, D, F)
  if (has('sale', 'sell', 'dispos') || code === 's' || code === 'd' || code === 'f') {
    return { modifier: 0.0, label: 'Sale', tier: 'excluded' };
  }
  // Open-market purchase (SEC code P / "buy" / "purchase") — the strongest signal
  if (has('purchase', 'buy') || code === 'p') {
    return { modifier: 1.0, label: 'Open Market Buy', tier: 'strong' };
  }
  // Unknown / empty — do NOT assume a buy (prevents bad scrapes scoring as purchases).
  return { modifier: 0.0, label: raw?.trim() ? `Unknown (${raw})` : 'Unknown', tier: 'excluded' };
}

// ──────────────────────────────────────────────────────────────────────────
// Insider name normalization — pure, shared by main (cluster dedup) + renderer
// (modal dedup). Kept in one place so the two sides can never drift apart.
// ──────────────────────────────────────────────────────────────────────────

const INSIDER_ROLE_SUFFIXES = [
  'director', 'officer', 'ceo', 'cfo', 'coo', 'president', '10% owner', '10%owner', 'owner', 'executive',
  'chairman', 'general counsel', 'general partner', 'secretary', 'treasurer', 'vice president', 'vp',
  'svp', 'evp', 'avp', 'trustee', 'beneficial owner', 'controller',
  // Full titles, for sources that glue the title onto the surname with no
  // separator ("Genner Gareth NevilleChief Executive Officer"). Stripping only
  // the trailing word would leave "...NevilleChief Executive" behind and the
  // row would never dedupe against the same person from a clean source.
  'chief executive officer', 'chief financial officer', 'chief operating officer',
  'chief technology officer', 'chief marketing officer', 'chief accounting officer',
  'chief information officer', 'chief legal officer', 'chief medical officer',
  'chief scientific officer', 'chief commercial officer', 'chief revenue officer',
  'chief compliance officer', 'chief investment officer', 'chief business officer',
  'chief product officer', 'chief people officer', 'chief security officer',
].sort((a, b) => b.length - a.length);

/**
 * Canonical key for an insider name: strips a trailing role/title (so the same
 * person filed as "Jane Doe CEO" and "Jane Doe Director" dedupes to one) and
 * reduces to lowercase alphanumerics.
 */
export function normalizeInsiderName(name: string): string {
  if (!name) return '';
  let clean = name.trim();
  const lower = clean.toLowerCase();
  for (const role of INSIDER_ROLE_SUFFIXES) {
    if (lower.endsWith(role)) {
      const prefix = clean.slice(0, -role.length).trim();
      if (prefix.length >= 3) {
        clean = prefix;
        break;
      }
    }
  }
  // Word-order-insensitive: sources disagree on name order ("Doe John" on
  // SEC-style feeds vs "John Doe" on aggregators), so sort the tokens before
  // collapsing — otherwise the same person double-counts volume and clusters.
  return clean
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join('');
}

// ──────────────────────────────────────────────────────────────────────────
// Date / freshness helpers (Feature 1) — pure, shared
// ──────────────────────────────────────────────────────────────────────────

export function daysBetween(fromIso?: string | null, toMs: number = Date.now()): number | null {
  const t = utcInstantMs(fromIso);
  return t === null || !Number.isFinite(toMs) ? null : (toMs - t) / 86_400_000;
}

/** Whole business days between two ISO dates (excludes weekends). Date-only strings retain their UTC calendar day. */
export function businessDaysBetween(startIso?: string | null, endIso?: string | null): number | null {
  if (!startIso || !endIso) return null;
  const startMs = utcInstantMs(startIso);
  const endMs = utcInstantMs(endIso);
  if (startMs === null || endMs === null) return null;
  if (endMs < startMs) return 0;
  let count = 0;
  const cur = new Date(startMs);
  cur.setUTCHours(0, 0, 0, 0);
  const end = new Date(endMs);
  end.setUTCHours(0, 0, 0, 0);
  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) count++;
  }
  return count;
}

/** Feature 1 — filed more than 4 business days after the trade. */
export function isLateFiling(tradeDate?: string | null, filingDate?: string | null): boolean {
  const bd = businessDaysBetween(tradeDate, filingDate);
  return bd != null && bd > 4;
}

/**
 * Feature 1 — freshness multiplier from signal age in days. The rate/floor
 * parameters exist for the shadow-scoring (A/B) framework; the defaults ARE
 * the production curve.
 *
 * BACKTEST 2026-07-03: upweighted (floor 0.2 → 0.15) — the only component
 * with confirmed out-of-sample alpha (IC(oos)=0.342, Q4−Q1 spread p=0.021,
 * n=88). The edge is concentrated in the STALE quartile (−4.2% 10d alpha vs
 * ≈+3% for the rest), so only the stale-end floor is deepened; the decay
 * rate is left at −0.115 because mid-age (2–4d) signals were the BEST
 * bucket and a uniformly faster decay would have punished them.
 */
export function getFreshnessMultiplier(ageDays: number | null, decayRate = 0.115, floor = 0.15): number {
  // Unknown age is NOT fresh. Returning 1.0 here handed a full-strength
  // multiplier to signals whose dates failed to parse, while a real, correctly
  // dated 10-day-old buy was discounted to ~0.32 — i.e. missing data outscored
  // present data. An undateable signal is treated as maximally stale instead.
  // NaN takes the same path (`NaN < 1` is false, so it used to fall through to
  // `exp(-rate·NaN)` = NaN and from there into the score).
  if (ageDays == null || !Number.isFinite(ageDays)) return floor;
  if (!Number.isFinite(decayRate) || !Number.isFinite(floor)) return 1.0;
  // A NEGATIVE age means the trade is dated in the future — always a parsing
  // error, never a real Form 4. It used to read as maximally fresh (×1.0), so a
  // date mis-parsed by a year became the freshest signal in the system. Treat it
  // like an undateable one.
  if (ageDays < 0) return floor;
  if (ageDays < 1) return 1.0;
  // Smooth exponential (half-life ≈ 6 days) instead of step cliffs, so a
  // signal no longer loses 30–50% of its insider leg overnight crossing a
  // bucket boundary.
  return Math.max(floor, Math.exp(-decayRate * ageDays));
}

// ──────────────────────────────────────────────────────────────────────────
// Shadow scoring (A/B framework) — tunable knobs as data
// ──────────────────────────────────────────────────────────────────────────

/**
 * The scoring model's tunable knobs. The defaults ARE the production model;
 * a shadow config (stored in app_settings) overrides some of them, and every
 * scrape then also computes a `shadowScore` per signal so candidate weights
 * can be compared against realized alpha before ever touching the live score.
 */
export interface ScoringConfig {
  /** Exponential freshness decay rate (default 0.115). */
  freshnessDecayRate: number;
  /** Freshness floor for stale signals (default 0.15). */
  freshnessFloor: number;
  /** Flat combo bonus added post-normalization (default 30). */
  comboBonus: number;
  /** Track-record curve slope around 0.5 (default 0.65). */
  trackRecordSlope: number;
  /** Saturating-curve half-saturation point (default 105). */
  scoreHalfSaturation: number;
  /** VIX ramp ceiling (default 1.15). */
  vixCap: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  freshnessDecayRate: 0.115,
  freshnessFloor: 0.15,
  comboBonus: 30,
  trackRecordSlope: 0.65,
  scoreHalfSaturation: 105,
  vixCap: 1.15,
};

export type FreshnessLevel = 'fresh' | 'recent' | 'aging' | 'stale';

export function getFreshnessLevel(ageDays: number | null): FreshnessLevel {
  // Unknown, non-finite and future-dated all mean "we cannot date this" — the
  // badge must agree with getFreshnessMultiplier, which floors all three.
  if (ageDays == null || !Number.isFinite(ageDays) || ageDays < 0) return 'stale';
  if (ageDays < 1) return 'fresh';
  if (ageDays <= 3) return 'recent';
  if (ageDays <= 7) return 'aging';
  return 'stale';
}

// ──────────────────────────────────────────────────────────────────────────
// Signal filtering (Feature 7) — pure, shared by store + DB IPC
// ──────────────────────────────────────────────────────────────────────────

function startOfDayMs(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Trade date → UTC ms. A date-only string ("YYYY-MM-DD") is treated as UTC
 * midnight; explicit-offset instants retain their exact time. This avoids the bug where a naive date
 * parsed as UTC midnight fell *before* a precise "now − 48h" cutoff, dropping
 * same-day / recent trades. Falls back to scrapedAt when no trade date is set.
 */
function signalTradeMs(s: Signal): number | null {
  return utcInstantMs(s.tradeDate || s.scrapedAt);
}

/**
 * Does this signal read as a COMBO to the user? True for the classic
 * insider+options combo AND for the politician tiers, because both render a COMBO
 * badge on the card. Shared by the filter, the stat cards and the notifications so
 * they can't disagree (the header said "0 combos" while three cards showed one).
 */
export function isComboSignal(s: Signal): boolean {
  return !!(s.comboSignal || s.breakdown?.politicianComboTier);
}

export function filterSignals(signals: Signal[], filter: SignalFilter): Signal[] {
  const now = Date.now();
  // Calendar-day cutoffs so same-day & recent trades reliably pass regardless of
  // timezone. 24h = today; 48h = today + yesterday; week = rolling last 7 days
  // (NOT "since Monday", which left the default view near-empty every Monday
  // morning — the exact failure mode the week default exists to avoid).
  let cutoff = -Infinity;
  if (filter.timeRange === '24h') cutoff = startOfDayMs(now);
  else if (filter.timeRange === '48h') cutoff = startOfDayMs(now) - 86_400_000;
  else if (filter.timeRange === 'week') cutoff = startOfDayMs(now) - 6 * 86_400_000;

  return signals.filter((s) => {
    // Time range (by trade date)
    if (filter.timeRange !== 'all') {
      const ms = signalTradeMs(s);
      if (ms == null || ms < cutoff) return false;
    }
    // Free-text search (ticker / company / insider), same rule the grid used to
    // apply locally.
    const q = filter.search?.trim().toLowerCase();
    if (q) {
      const hit =
        s.ticker.toLowerCase().includes(q) ||
        !!s.companyName?.toLowerCase().includes(q) ||
        !!s.rawTrades?.some((t) => t.insiderName.toLowerCase().includes(q));
      if (!hit) return false;
    }
    // Transaction-type filter. A politician combo tier (POLITICIAN_INSIDER /
    // _OPTIONS / MEGA_SIGNAL) badges the card as a COMBO too, so it must satisfy
    // the combo filter — otherwise the card shows "COMBO" but the filter hides it.
    if (filter.type === 'combo' && !isComboSignal(s)) return false;
    if (filter.type === 'options' && (s.optionsActivity?.length ?? 0) === 0) return false;
    if (filter.type === 'openmarket') {
      const hasOpenMarket = (s.rawTrades ?? []).some((t) => classifyTransaction(t.transactionType).modifier >= 1);
      if (!hasOpenMarket) return false;
    }
    // Conviction filter
    if (filter.conviction !== 'all' && s.convictionLevel !== filter.conviction) return false;
    // Big player filter
    if (filter.bigPlayersOnly && !s.bigPlayer) return false;
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Constants shared across processes
// ──────────────────────────────────────────────────────────────────────────

export interface RoleCategory {
  key: string;
  label: string;
  weight: number;
}

export const ROLE_CATEGORIES: readonly RoleCategory[] = [
  { key: 'exec', label: 'CEO / Executive Chairman', weight: 10 },
  { key: 'cfo', label: 'CFO / COO / President', weight: 8 },
  { key: 'csuite', label: 'CTO / CMO / Other C-Suite', weight: 6 },
  { key: 'director', label: 'Director / Board Member', weight: 4 },
  { key: 'vp', label: 'VP / Senior Officer', weight: 3 },
  { key: 'other', label: 'Other Insider', weight: 1 },
] as const;

export interface SourceMeta {
  key: ScraperSource;
  label: string;
  kind: 'insider' | 'options';
  url: string;
  /** Whether the site usually needs auth (best-effort, graceful fallback). */
  authOptional?: boolean;
}

export const SCRAPER_SOURCES: readonly SourceMeta[] = [
  { key: 'edgar', label: 'SEC EDGAR', kind: 'insider', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=include&count=100' },
  { key: 'openinsider', label: 'OpenInsider', kind: 'insider', url: 'http://openinsider.com/latest-insider-purchases-25k' },
  { key: 'finviz', label: 'Finviz Insider', kind: 'insider', url: 'https://finviz.com/insidertrading.ashx' },
  { key: 'secform4', label: 'SECForm4', kind: 'insider', url: 'https://www.secform4.com/all-buys' },
  { key: 'marketbeat', label: 'MarketBeat', kind: 'insider', url: 'https://www.marketbeat.com/insider-trades/' },
  { key: 'insidermonitor', label: 'Insider Monitor', kind: 'insider', url: 'http://www.insider-monitor.com/insider_stock_purchases.html' },
  { key: 'quiverquant', label: 'Quiver Insiders', kind: 'insider', url: 'https://www.quiverquant.com/insiders/' },
  { key: 'ceowatcher', label: 'CEOWatcher (IG)', kind: 'insider', url: 'https://www.instagram.com/ceowatcher/' },
  { key: 'barchart', label: 'Barchart Options', kind: 'options', url: 'https://www.barchart.com/options/unusual-activity/stocks' },
  { key: 'optionstrat', label: 'OptionStrat Flow', kind: 'options', url: 'https://optionstrat.com/flow', authOptional: true },
  { key: 'insiderfinance', label: 'InsiderFinance Flow', kind: 'options', url: 'https://www.insiderfinance.io/flow', authOptional: true },
  { key: 'marketbeatoptions', label: 'MarketBeat Options Volume', kind: 'options', url: 'https://www.marketbeat.com/market-data/unusual-call-options-volume/' },
] as const;

/**
 * Always-on side pipelines (not Settings toggles) but still tracked in scrape
 * session breakdown + source health. Keys appear in sourceBreakdown.
 * Sentinel: count < 0 means the pipeline hard-failed (vs 0 = ran, found nothing).
 */
export const SIDE_PIPELINE_SOURCES: readonly { key: string; label: string }[] = [
  { key: 'capitoltrades', label: 'Congressional Trades' },
  { key: 'sellside', label: 'Sell-side Flow' },
  { key: 'activist', label: '13D/13G Activist' },
] as const;

/** All keys that participate in source health / session breakdown labels. */
export function sourceLabel(key: string): string {
  const main = SCRAPER_SOURCES.find((s) => s.key === key);
  if (main) return main.label;
  const side = SIDE_PIPELINE_SOURCES.find((s) => s.key === key);
  return side?.label ?? key;
}

// ──────────────────────────────────────────────────────────────────────────
// Platform logins (authenticated scraping)
// ──────────────────────────────────────────────────────────────────────────

export interface NewsItem {
  id: number;
  tweetId: string;
  text: string;
  timestamp: string;
  url: string;
  scrapedAt: string;
}

export type LoginGating = 'required' | 'optional';

export interface LoginPlatform {
  key: string;
  label: string;
  /** Page to open for the user to log in manually. */
  loginUrl: string;
  category: 'insider' | 'options' | 'news';
  /** 'required' means the scrape source toggle stays locked until logged in. */
  gating: LoginGating;
  /** The scraper source this login gates/improves. */
  sourceKey?: ScraperSource;
  /** Translation key for the one-line hint (see src/lib/i18n.ts). */
  hintKey?: string;
}

/**
 * Platforms the user can authenticate to so the scraper reads past free-view
 * limits / account-gated data. Login captures the browser session (cookies) -
 * no passwords are stored.
 */
export const LOGIN_PLATFORMS: readonly LoginPlatform[] = [
  { key: 'optionstrat', label: 'OptionStrat', loginUrl: 'https://optionstrat.com/login', category: 'options', gating: 'required', sourceKey: 'optionstrat', hintKey: 'plat.hintOptionsAccount' },
  { key: 'insiderfinance', label: 'InsiderFinance', loginUrl: 'https://www.insiderfinance.io/login', category: 'options', gating: 'required', sourceKey: 'insiderfinance', hintKey: 'plat.hintOptionsAccount' },
  { key: 'barchart', label: 'Barchart', loginUrl: 'https://www.barchart.com/login', category: 'options', gating: 'optional', sourceKey: 'barchart', hintKey: 'plat.hintBarchart' },
  { key: 'finviz', label: 'Finviz Elite', loginUrl: 'https://finviz.com/login.ashx', category: 'insider', gating: 'optional', sourceKey: 'finviz', hintKey: 'plat.hintFinviz' },
  { key: 'marketbeat', label: 'MarketBeat', loginUrl: 'https://www.marketbeat.com/login/', category: 'insider', gating: 'optional', sourceKey: 'marketbeat' },
  { key: 'twitter', label: 'Twitter/X', loginUrl: 'https://x.com/login', category: 'news', gating: 'required', hintKey: 'plat.hintTwitter' },
] as const;

export interface AuthInfo {
  loggedIn: boolean;
  savedAt: string | null;
}

/** platform key -> auth info. */
export type AuthStatus = Record<string, AuthInfo>;

/** True if a gated scraper source is allowed to run (public, or logged in). */
export function isSourceUnlocked(sourceKey: ScraperSource, auth: AuthStatus): boolean {
  const platform = LOGIN_PLATFORMS.find((p) => p.sourceKey === sourceKey);
  if (!platform) return true;
  return !!auth[platform.key]?.loggedIn;
}

export const CONVICTION_THRESHOLDS = {
  high: 80,
  watch: 50,
} as const;

// ──────────────────────────────────────────────────────────────────────────
// Corroboration model (live) — SHARED, because the breakdown UI renders these
// exact numbers. They used to live only in electron/scoring.ts while the UI
// carried its own copy of the LEGACY flat bonuses, so a MEGA signal was labelled
// "+45 Bonus" on screen while the score had actually received ×1.25 (and only
// above the gate). Two copies, two different models, one of them wrong.
// ──────────────────────────────────────────────────────────────────────────

/** Soft multipliers applied to the normalized score when signals corroborate. */
export const COMBO_SOFT_MULT = 1.2;
export const POLITICIAN_INSIDER_SOFT_MULT = 1.18;
export const POLITICIAN_OPTIONS_SOFT_MULT = 1.15;
export const MEGA_SOFT_MULT = 1.25;

/** The soft multiplier a politician-combo tier contributes (live model). */
export const POLITICIAN_COMBO_SOFT_MULT: Record<PoliticianComboTier, number> = {
  MEGA_SIGNAL: MEGA_SOFT_MULT,
  POLITICIAN_INSIDER: POLITICIAN_INSIDER_SOFT_MULT,
  POLITICIAN_OPTIONS: POLITICIAN_OPTIONS_SOFT_MULT,
};

/**
 * Pre-v1.0.46 flat bonuses. Kept ONLY for the legacy/shadow comparison score —
 * never render these as the live model.
 */
export const LEGACY_POLITICIAN_COMBO_BONUS: Record<PoliticianComboTier, number> = {
  MEGA_SIGNAL: 45,
  POLITICIAN_INSIDER: 25,
  POLITICIAN_OPTIONS: 20,
};

/** A corroboration multiplier applies only once the base score is at/above WATCH. */
export const CORROBORATION_GATE: number = CONVICTION_THRESHOLDS.watch;

// Scoring maxima shared by the score model (electron/scoring.ts) and the
// breakdown UI (ScoreBreakdown.tsx) so progress-bar fills can't drift from the
// real ceilings if the model is retuned.
/** Max insider earnings-timing multiplier: earnings 1–5d (1.8) × finance pre-earnings (1.3). */
export const MAX_INSIDER_TIMING_MULT = 1.8 * 1.3; // 2.34
/**
 * Top rung of the premium ladder in `baseOptionPoints()` (electron/scoring.ts).
 * Shared so the ladder and the display ceilings below can never drift apart.
 */
export const MAX_OPTION_BASE_POINTS = 26;
/** Max points for a single option: base(26) × sweep(1.6) × dte(1.5) × otm(1.4) × volOi(1.3). */
export const MAX_SINGLE_OPTION_POINTS = MAX_OPTION_BASE_POINTS * 1.6 * 1.5 * 1.4 * 1.3; // 113.568
/**
 * Display ceiling for the summed per-direction options score: best print plus
 * a geometric tail (best + ½·2nd + ¼·3rd + … < 2× best).
 */
export const MAX_OPTIONS_SCORE_TOTAL = MAX_SINGLE_OPTION_POINTS * 2; // 227.136

// Track-record reliability controls (Feature 6). A win rate over a handful of
// trades is mostly noise, so the scoring multiplier ignores insiders below a
// minimum sample and shrinks the rest toward 0.5 (coin-flip) before judging them.
/** Minimum number of completed-outcome trades for an insider's record to influence scoring. */
export const MIN_TRACK_RECORD_TRADES = 5;
/** Pseudo-count for Bayesian shrinkage toward 0.5 (higher = more regression to the mean). */
export const TRACK_RECORD_SHRINKAGE_K = 3;

/**
 * Bayesian-shrunk win rate: (wins + k·0.5) / (n + k). Pulls small samples toward
 * 0.5 so a 1-for-1 record reads ~0.625, not 1.0, while a 30-for-40 reads ~0.733
 * instead of 0.75.
 */
export function shrunkAccuracy(wins: number, total: number, k = TRACK_RECORD_SHRINKAGE_K): number {
  if (total <= 0) return 0.5;
  return (wins + k * 0.5) / (total + k);
}

export const DEFAULT_SETTINGS: AppSettings = {
  scheduleEnabled: true,
  scheduleTimes: { marketOpen: true, midday: true, close: true },
  notificationThreshold: 80,
  minDollarVolume: 50_000,
  webPublishEnabled: true,
  // Empty = fall back to the working directory (works when run from source).
  webPublishRepoPath: '',
  roleFilters: {
    exec: true,
    cfo: true,
    csuite: true,
    director: true,
    vp: true,
    other: true,
  },
  sources: {
    edgar: true,
    openinsider: true,
    finviz: true,
    secform4: true,
    marketbeat: true,
    insidermonitor: true,
    quiverquant: true,
    ceowatcher: true,
    barchart: true,
    optionstrat: false,
    insiderfinance: false,
    marketbeatoptions: true,
  },
  headless: true,
};

// ──────────────────────────────────────────────────────────────────────────
// Testing portfolio (v1.4.0) — a simulated, rule-based book that "invests" in
// the terminal's strongest signals and is plotted against SPY.
//
// The whole point is that a sceptic can audit it, so every knob is a NAMED
// constant here (one place, no magic numbers downstream) and every one of them
// is overridable at runtime through PortfolioConfig.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Entry threshold. Deliberately NOT `CONVICTION_THRESHOLDS.high` (80): only 3
 * ticker-days in the whole stored history have ever reached 80, so that
 * constant would build a portfolio that essentially never trades.
 *
 * 74 was a guess, and its old justification here — "the level at which the
 * labeled outcomes still show a clear alpha edge" — does not survive
 * `npm run analyze:score`. Restricted to rows with scoring content and with
 * cluster-robust standard errors, the score→alpha IC is in the noise at every
 * horizon (5d +0.052 t=1.89 · 10d ≈ 0 · 20d −0.023 t=−0.43). Mean 10-day alpha
 * above 70 is 6.69% (n=13 ticker-days) against 6.44% above 74 (n=9): the same
 * number twice. **No threshold in this range can be justified by returns**, and
 * fitting one to these outcomes would be fitting noise — see the caveat
 * `portfolio:sweep` prints, where the sign flips between adjacent rows.
 *
 * So it is set on the one quantity the data DOES resolve: signal supply against
 * the book's own capacity. Little's Law, L = λW, over 2026-07-10 → 08-26:
 *
 *   threshold   λ (distinct tickers/wk)   L at the 90-day hold cap   of 20 slots
 *   ≥ 66        2.38                      30.6                      153%  ✗
 *   ≥ 68        1.79                      23.0                      115%  ✗
 *   ≥ 70        1.34                      17.2                       86%  ✓
 *   ≥ 74        1.04                      13.4                       67%
 *
 * 70 is the highest threshold that fills the 20-position book without
 * over-subscribing it. Over-subscribing is the worse error: signals past the
 * cap are silently rejected (`skipped_cap`), which biases the very measurement
 * the portfolio exists to make. 74 leaves a third of the capacity permanently
 * in SPY, so a third of the "result" was never a test of the signals at all.
 *
 * Two properties confirm the level rather than choosing it:
 *  - 70 sits at p99.21 of content-bearing signals (74 at p99.45) and inside the
 *    same 60–79 bucket, which is the best-performing bucket with n ≥ 30 at both
 *    5 and 10 days. This moves within measured ground, not past it. Rows with
 *    no scoring content score ≈ 0, so no threshold near here can dilute the
 *    book with them.
 *  - It makes the sizing ramp reachable. `maxWeight` binds at
 *    `entryScore + scoreSpan`; at 74 that was 90, above the all-time high score
 *    of 85.1, so the 10% cap was dead code and every position sized off a
 *    fraction of the intended range. At 70 the ramp ends at 86 — just past the
 *    observed maximum, which is where a ramp should end.
 *
 * This is a decision about statistical power, NOT a claim that 70-scored
 * signals beat 74-scored ones. Revisit when the closed-trade count reaches ~20,
 * which is the first point at which the alpha question has an answer.
 */
export const PORTFOLIO_ENTRY_SCORE = 70;
/** Score points above the threshold that double the base weight. */
export const PORTFOLIO_SCORE_SPAN = 16;
export const PORTFOLIO_BASE_WEIGHT = 0.05;
export const PORTFOLIO_MIN_WEIGHT = 0.03;
export const PORTFOLIO_MAX_WEIGHT = 0.1;
export const PORTFOLIO_MAX_POSITIONS = 20;
/** Below this the remaining cash is not worth a trade — the signal is skipped. */
export const PORTFOLIO_MIN_TICKET = 100;
/** Same ticker is locked out for this long after a sale (kills alarm loops). */
export const PORTFOLIO_REENTRY_COOLDOWN_DAYS = 10;
/**
 * Take-profit: DISABLED (v1.5.0). Not "set very high" — genuinely off, because a
 * fixed cap on the upside is a structural error rather than a badly tuned number.
 *
 * Individual stock returns are strongly right-skewed (Bessembinder 2018), so the
 * minority of positions that run far past any round-number target carry more than
 * the whole expected return of the book — modelled at 90 days and 50% annualised
 * vol, paths above +20% contribute +10.2pp against a +5.0pp total, and a hard
 * +20% cap turns that +5.0% into −0.2%. Selling winners on a fixed rung while
 * losers run to the full stop is also the disposition effect (Odean 1998) written
 * into code. The upside exit is the TRAILING stop, which is path-dependent and
 * therefore cannot truncate a trend that is still going.
 *
 * Full derivation and sources: docs/portfolio/EXIT-STRATEGY.md.
 */
export const PORTFOLIO_TAKE_PROFIT: number | null = null;
/**
 * Magnitude, not a signed number: a -25% stop is `0.25`.
 *
 * Widened from 10%. A stop only adds expected return where returns are positively
 * serially correlated (Kaminski & Lo 2014); at the 1-month horizon individual
 * stocks are in the short-term REVERSAL regime (Jegadeesh 1990), which is exactly
 * where a tight stop sells the bottom. −10% is also inside one horizon sigma for
 * almost every ticker this terminal surfaces, so it fired on noise rather than on
 * the thesis being wrong. What is left at −25% ≈ 1 sigma over a 90-day hold is a
 * tail-risk brake (fraud, dilution, delisting), not an alpha rule.
 */
export const PORTFOLIO_STOP_LOSS: number | null = 0.25;
/**
 * Time stop, calendar days. Raised from 30.
 *
 * The insider-purchase drift is measured over SIX to TWELVE months across every
 * large study (Jeng/Metrick/Zeckhauser 2003; Lakonishok/Lee 2001; Cohen/Malloy/
 * Pomorski 2012). Half of the six-month abnormal return accrues in the first
 * month, but the other half accrues over months two to six at a roughly CONSTANT
 * ~1.5-2 bps per trading day — it does not decay to zero at day 30. Because our
 * qualifying signals are scarce relative to the 20 position slots, the capital
 * freed by an early exit parks in SPY at zero alpha by construction, so every
 * extra day held at positive marginal alpha is a gain rather than an opportunity
 * cost. 90 days is the conservative end of the literature's range, and the
 * longest horizon this database can ever validate in-sample.
 */
export const PORTFOLIO_MAX_HOLD_DAYS = 90;
/**
 * Trailing stop — now the ONLY upside exit, so both legs were widened.
 *
 * At +15%/10% the trail gave back barely 0.4 horizon sigma, which on a 45%-vol
 * ticker is noise; it would have closed most positions inside the first month and
 * re-created the take-profit through the back door. This is the least
 * evidence-backed pair in the set (see EXIT-STRATEGY.md §"what would change our
 * mind") — no study tests trailing-stop geometry on insider signals.
 */
export const PORTFOLIO_TRAIL_ARM = 0.25;
export const PORTFOLIO_TRAIL_DISTANCE = 0.2;
/**
 * Lookback for the realised-volatility estimate that the OPTIONAL sigma-scaled
 * barriers use. 60 trading days is the conventional window: long enough to be
 * stable, short enough to track a regime change.
 */
export const PORTFOLIO_SIGMA_LOOKBACK_DAYS = 60;
/** Trading days per calendar day — converts a time stop into a sigma horizon. */
export const PORTFOLIO_TRADING_DAYS_PER_CALENDAR_DAY = 252 / 365;
/** 5 bps = 0.05% per side, charged on every fill including the SPY cash leg. */
export const PORTFOLIO_SLIPPAGE_BPS = 5;
export const PORTFOLIO_STARTING_CASH = 10_000;

/**
 * The day the book opens. Nothing before it exists: no curve, no positions, and
 * no signal older than it is bought late.
 *
 * Set to 2026-09-01 for the reset. Everything before it was a BACKFILL — the
 * strategy replayed over signal history that had already happened, which can
 * only ever be a rehearsal: the rules were chosen while that history was
 * visible, so it cannot also be the evidence for them. From here the book only
 * ever acts on signals it did not know about in advance, which is the only
 * version of this number worth quoting.
 */
export const PORTFOLIO_INCEPTION = '2026-09-01';
/**
 * Search window for a tradable close. A date without a price is not a trading
 * day; beyond this many calendar days the series is treated as gone.
 */
export const PORTFOLIO_PRICE_SEARCH_DAYS = 5;
/**
 * UTC hour at/after which a sighting counts as POST-CLOSE, so the signal can
 * only be acted on at the NEXT session's close.
 *
 * 20:00 UTC is 16:00 New York during EDT. Under EST the real close is 21:00
 * UTC, so this errs one hour early for four winter months — it can only ever
 * delay an entry, never advance one, which is the only direction that is safe.
 * Deriving it from a live timezone lookup would make the curve depend on the
 * machine's tz database, and reproducibility matters more than that hour.
 * Measured: 2,201 of 12,728 stored sightings are at/after 20:00 UTC, so this is
 * not a theoretical case.
 */
export const PORTFOLIO_SESSION_CLOSE_UTC_HOUR = 20;

export type PortfolioCashPolicy = 'spy' | 'idle';
export type PortfolioExitReason = 'take_profit' | 'stop_loss' | 'trailing' | 'time' | 'data_missing';
export type PortfolioEventKind =
  | 'buy'
  | 'sell'
  | 'skipped_no_cash'
  | 'skipped_cap'
  | 'data_missing'
  | 'suspect_price';

/**
 * OPTIONAL volatility-scaled barriers (Lopez de Prado's triple-barrier
 * formulation, where the horizontal barriers are multiples of an estimated
 * volatility rather than round percentages).
 *
 * `null` on the config means "use the fixed percentages". When it is set, each
 * non-null multiple REPLACES its fixed counterpart with `multiple x sigmaH`,
 * where sigmaH is the position's realised daily volatility at entry scaled to
 * the length of the time stop. A position with no usable volatility estimate
 * silently falls back to the fixed percentage — a barrier that cannot be
 * computed must not become a barrier that never fires.
 *
 * Off by default in the shipped book: the principle is well supported
 * (Barroso/Santa-Clara 2015; Moreira/Muir 2017), the specific multiples are not,
 * and this repo does not adopt an unvalidated rule. `npm run portfolio:sweep`
 * runs it so the evidence can accumulate.
 */
export interface PortfolioSigmaBarriers {
  /** Stop-loss distance in horizon sigmas. */
  stop: number | null;
  /** Take-profit distance in horizon sigmas. */
  target: number | null;
  /** Trailing-stop arming level in horizon sigmas. */
  trailArm: number | null;
  /** Trailing-stop give-back distance in horizon sigmas. */
  trailDistance: number | null;
}

export interface PortfolioConfig {
  startingCash: number;
  /**
   * First day the book may trade, `null` for "as far back as the data reaches".
   * Part of the CONFIG rather than a constant so that changing it invalidates
   * the stored curve through the same `sameConfig` check every other rule uses
   * — a curve that starts on a different day is a different book.
   */
  inceptionDate: string | null;
  entryScore: number;
  scoreSpan: number;
  baseWeight: number;
  minWeight: number;
  maxWeight: number;
  maxPositions: number;
  minTicket: number;
  reentryCooldownDays: number;
  /** `null` DISABLES the barrier — there is then no upside cap at all. */
  takeProfit: number | null;
  /** Positive magnitude (0.25 = a -25% stop). `null` disables the stop. */
  stopLoss: number | null;
  maxHoldDays: number;
  trailArm: number;
  trailDistance: number;
  slippageBps: number;
  /** `null` = fixed percentages (the shipped default). */
  sigmaBarriers?: PortfolioSigmaBarriers | null;
  /**
   * Where uninvested capital sits. `spy` makes the book "S&P 500 + signal
   * overlay", so the gap to the benchmark IS the contribution of the signals
   * and nothing else. `idle` leaves it as 0%-yield cash.
   */
  cashPolicy: PortfolioCashPolicy;
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  startingCash: PORTFOLIO_STARTING_CASH,
  inceptionDate: PORTFOLIO_INCEPTION,
  entryScore: PORTFOLIO_ENTRY_SCORE,
  scoreSpan: PORTFOLIO_SCORE_SPAN,
  baseWeight: PORTFOLIO_BASE_WEIGHT,
  minWeight: PORTFOLIO_MIN_WEIGHT,
  maxWeight: PORTFOLIO_MAX_WEIGHT,
  maxPositions: PORTFOLIO_MAX_POSITIONS,
  minTicket: PORTFOLIO_MIN_TICKET,
  reentryCooldownDays: PORTFOLIO_REENTRY_COOLDOWN_DAYS,
  takeProfit: PORTFOLIO_TAKE_PROFIT,
  stopLoss: PORTFOLIO_STOP_LOSS,
  maxHoldDays: PORTFOLIO_MAX_HOLD_DAYS,
  trailArm: PORTFOLIO_TRAIL_ARM,
  trailDistance: PORTFOLIO_TRAIL_DISTANCE,
  slippageBps: PORTFOLIO_SLIPPAGE_BPS,
  sigmaBarriers: null,
  cashPolicy: 'spy',
};

/**
 * Bumped whenever a SHIPPED default changes in a way that an already-stored
 * `app_settings.portfolio_config` overlay would otherwise mask. `getPortfolioConfig`
 * merges the stored blob OVER these defaults, so a v1 installation would keep
 * running +20% / -10% / 30d forever without this. See the migration in
 * electron/database.ts and docs/portfolio/EXIT-STRATEGY.md.
 *
 * 3: `entryScore` 74 → 70. Not an exit rule — the same masking applies to ANY
 * default the rules editor has written back into the overlay, which is why the
 * migration now reads PORTFOLIO_SUPERSEDED_DEFAULTS rather than the exit rules
 * alone.
 */
export const PORTFOLIO_CONFIG_VERSION = 3;

/**
 * The v1 (v1.4.0) exit rules, kept verbatim so the migration can tell an
 * untouched default apart from a value the user deliberately chose.
 */
export const PORTFOLIO_V1_EXIT_DEFAULTS = {
  takeProfit: 0.2,
  stopLoss: 0.1,
  maxHoldDays: 30,
  trailArm: 0.15,
  trailDistance: 0.1,
} as const;

/** The v2 (v1.5.0) entry threshold, superseded by the capacity derivation above. */
export const PORTFOLIO_V2_DEFAULTS = {
  entryScore: 74,
} as const;

/**
 * Every default this project has shipped and then replaced, by key. A stored
 * value equal to any of them was never chosen — it is a default that got frozen
 * into the overlay by the rules editor, which writes the whole merged object
 * back. Those yield to the current default; anything else is the user's and is
 * kept.
 */
export const PORTFOLIO_SUPERSEDED_DEFAULTS: Readonly<Record<string, readonly unknown[]>> = {
  ...Object.fromEntries(Object.entries(PORTFOLIO_V1_EXIT_DEFAULTS).map(([k, v]) => [k, [v]])),
  ...Object.fromEntries(Object.entries(PORTFOLIO_V2_DEFAULTS).map(([k, v]) => [k, [v]])),
};

/** Where a candidate signal came from — decides how its entry date is derived. */
export type PortfolioSignalSource = 'signal' | 'outcome';

export interface PortfolioCandidate {
  ticker: string;
  /** Earliest calendar date whose CLOSE was still ahead of the sighting. */
  earliestDate: string;
  score: number;
  signalId: number | null;
  source: PortfolioSignalSource;
}

export interface PortfolioPosition {
  id: number;
  ticker: string;
  signalId: number | null;
  entryDate: string;
  /** Fill price including slippage. */
  entryPrice: number;
  shares: number;
  costBasis: number;
  entryScore: number;
  targetWeight: number;
  highWaterClose: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: PortfolioExitReason | null;
  realizedPnl: number | null;
  spyEntry: number | null;
  spyExit: number | null;
}

/** An open position enriched with today's mark — never stored, always derived. */
export interface PortfolioOpenPosition extends PortfolioPosition {
  /** Date of the actual quote; optional for older static payloads. */
  priceAsOf?: string | null;
  priceStale?: boolean;
  lastPrice: number | null;
  marketValue: number;
  unrealizedPct: number | null;
  weight: number;
  holdDays: number;
  /** Which barrier is closest right now, and how far away it is (fraction). */
  nearestBarrier: PortfolioExitReason | null;
  nearestBarrierPct: number | null;
}

export interface PortfolioClosedPosition extends PortfolioPosition {
  holdDays: number;
  returnPct: number;
  /** Realized return minus SPY over EXACTLY the same holding period. */
  tradeAlpha: number | null;
}

export interface PortfolioEquityPoint {
  date: string;
  cash: number;
  spyCashValue: number;
  positionsValue: number;
  /** Headline NAV under the ACTIVE cash policy. */
  equity: number;
  /** Same rules, uninvested capital left as cash — the honest cash-drag line. */
  equityIdle: number;
  /** SPY buy and hold, same start day, same starting cash, same entry slippage. */
  benchmark: number;
  openPositions: number;
}

export interface PortfolioEvent {
  date: string;
  kind: PortfolioEventKind;
  ticker: string | null;
  score: number | null;
  amount: number | null;
  note: string | null;
}

export type PortfolioWindowKey = '7d' | '30d' | '6m' | '1y' | 'max';

/** Window lengths in CALENDAR days. `max` is "since the first day". */
export const PORTFOLIO_WINDOWS: { key: PortfolioWindowKey; days: number | null }[] = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '6m', days: 182 },
  { key: '1y', days: 365 },
  { key: 'max', days: null },
];

export interface PortfolioWindowStat {
  key: PortfolioWindowKey;
  /** Fractional return, or null when the history is shorter than the window. */
  portfolio: number | null;
  benchmark: number | null;
  diff: number | null;
  /** Calendar days of history still missing before this window can be computed. */
  daysRemaining: number | null;
  /** Trading-day observations inside the window (drives the small-sample hint). */
  n: number;
}

export interface PortfolioMetric {
  portfolio: number | null;
  benchmark: number | null;
  diff: number | null;
  /** Days of history still missing; null when the metric is computable. */
  daysRemaining: number | null;
}

export interface PortfolioTradeStats {
  total: number;
  closed: number;
  open: number;
  winRate: number | null;
  avgHoldDays: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  best: { ticker: string; returnPct: number } | null;
  worst: { ticker: string; returnPct: number } | null;
  /** THE headline number: mean per-trade alpha vs SPY over identical windows. */
  avgTradeAlpha: number | null;
  alphaN: number;
  /** Share of NAV currently in signal positions (excludes parked SPY cash). */
  investedRatio: number;
}

export interface PortfolioStats {
  spanDays: number;
  windows: PortfolioWindowStat[];
  cagr: PortfolioMetric;
  maxDrawdown: PortfolioMetric;
  volatility: PortfolioMetric;
  sharpe: PortfolioMetric;
  trades: PortfolioTradeStats;
}

/** Minimum history (calendar days) before these derived numbers mean anything. */
export const PORTFOLIO_MIN_DAYS_CAGR = 90;
export const PORTFOLIO_MIN_DAYS_SHARPE = 60;
/** Below this many observations a cell is flagged as a small sample. */
export const PORTFOLIO_SMALL_SAMPLE_N = 20;

export interface PortfolioMeta {
  /** False until a run has actually produced a curve. */
  available: boolean;
  firstDate: string | null;
  lastDate: string | null;
  /** First day of the run, reconstructed from stored signal history. */
  backfillStart: string | null;
  /** First day whose candidates came from live `signals` rows. */
  liveStart: string | null;
  lastRun: string | null;
  skippedNoCash: number;
  skippedCap: number;
  missingPrices: number;
  suspectPrices: number;
  /** Tickers that qualified but had no usable price series. */
  untradableTickers: string[];
  /**
   * Stored days whose re-simulation no longer matches, because Yahoo restated
   * the adjusted closes (a split/dividend rescales the WHOLE history). The
   * stored curve is authoritative and stays frozen; this counts the drift.
   */
  restatedDays: number;
  /** Newest close available from the price cache. */
  priceAsOf: string | null;
  /** True when this state came from a static publish (web build). */
  readOnly: boolean;
  note: string | null;
}

export interface PortfolioExperiment {
  id: string;
  /** Earlier results are retrospective simulations, not a live track record. */
  definedAt: string;
  state: PortfolioState;
}

export interface PortfolioState {
  insiderOnly?: PortfolioExperiment | null;
  config: PortfolioConfig;
  meta: PortfolioMeta;
  equity: PortfolioEquityPoint[];
  open: PortfolioOpenPosition[];
  closed: PortfolioClosedPosition[];
  events: PortfolioEvent[];
  stats: PortfolioStats;
}

// ──────────────────────────────────────────────────────────────────────────
// IPC surface (implemented by preload, consumed by renderer)
// ──────────────────────────────────────────────────────────────────────────

export interface InsiderTrackerAPI {
  analysis: {
    analyze: (ticker: string) => Promise<import('./analysis').StockAnalysis>;
    search: (query: string) => Promise<import('./analysis').StockSuggestion[]>;
  };
  scraper: {
    start: () => Promise<ScrapeResult>;
    getStatus: () => Promise<ScrapeStatus>;
    onStatus: (cb: (status: ScrapeStatus) => void) => () => void;
  };
  signals: {
    getAll: () => Promise<Signal[]>;
    getByTicker: (ticker: string) => Promise<Signal | null>;
    getHistory: (ticker: string) => Promise<Signal[]>;
    getFiltered: (filter: SignalFilter) => Promise<Signal[]>;
    getPerformance: (ticker: string) => Promise<SignalPerformance | null>;
    exportCsv: () => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  };
  watchlist: {
    add: (ticker: string, notes?: string) => Promise<WatchlistItem[]>;
    remove: (ticker: string) => Promise<WatchlistItem[]>;
    getAll: () => Promise<WatchlistItem[]>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    set: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  };
  earnings: {
    fetch: (ticker: string) => Promise<{ earningsDate?: string; daysToEarnings?: number; earningsTiming?: string }>;
  };
  vix: {
    getCurrent: () => Promise<VixQuote | null>;
  };
  insider: {
    getTrackRecord: (name: string, role?: string, url?: string) => Promise<InsiderTrackRecord | null>;
  };
  auth: {
    status: () => Promise<AuthStatus>;
    startLogin: (platform: string) => Promise<{ ok: boolean; message?: string }>;
    saveLogin: (platform: string) => Promise<{ ok: boolean; message?: string }>;
    cancelLogin: (platform: string) => Promise<void>;
    logout: (platform: string) => Promise<AuthStatus>;
  };
  history: {
    getScrapeLogs: () => Promise<ScrapeLogEntry[]>;
  };
  alerts: {
    getRules: () => Promise<AlertRule[]>;
    addRule: (rule: AlertRule) => Promise<AlertRule[]>;
    removeRule: (id: number) => Promise<AlertRule[]>;
    toggleRule: (id: number, enabled: boolean) => Promise<AlertRule[]>;
  };
  performance: {
    getLatest: () => Promise<PerformanceReport | null>;
    recompute: () => Promise<PerformanceReport>;
  };
  /**
   * Testing portfolio. On the hosted build `sync`/`rebuild`/`setConfig` are
   * no-ops that return the published state — the curve is computed by CI, not
   * by the browser — and the UI hides the buttons there (see `PortfolioMeta.readOnly`).
   */
  portfolio: {
    getState: () => Promise<PortfolioState>;
    sync: () => Promise<PortfolioState>;
    rebuild: () => Promise<PortfolioState>;
    setConfig: (config: Partial<PortfolioConfig>) => Promise<PortfolioState>;
  };
  shadow: {
    get: () => Promise<Partial<ScoringConfig> | null>;
    set: (config: Partial<ScoringConfig> | null) => Promise<Partial<ScoringConfig> | null>;
  };
  db: {
    clear: () => Promise<void>;
  };
  news: {
    getAll: () => Promise<NewsItem[]>;
    getForTicker: (ticker: string) => Promise<NewsItem[]>;
    scrapeNow: () => Promise<void>;
    setAutoStart: (enabled: boolean) => Promise<void>;
    getAutoStart: () => Promise<boolean>;
  };
  app: {
    getVersion: () => Promise<string>;
    getLastScrape: () => Promise<string | null>;
    onSignalsUpdated: (cb: (signals: Signal[]) => void) => () => void;
    onOpenTicker: (cb: (ticker: string) => void) => () => void;
    onUpdateAvailable: (cb: (version: string) => void) => () => void;
    onUpdateDownloaded: (cb: (version: string) => void) => () => void;
    onUpdateError: (cb: (err: string) => void) => () => void;
    quitAndInstall: () => Promise<void>;
    getUpdateStatus: () => Promise<{ status: 'idle' | 'available' | 'downloaded'; version: string }>;
    testSchedule: () => Promise<void>;
    setTheme: (theme: string) => Promise<void>;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Big Players Constants & Helpers
// ──────────────────────────────────────────────────────────────────────────

export const BIG_PLAYERS = new Set<string>([
  'AAOI', 'AAPL', 'ABBV', 'ABT', 'ACN', 'ADBE', 'ADSK', 'AEP', 'AIG', 'ALB',
  'ALGN', 'ALK', 'ALL', 'AMAT', 'AMD', 'AMGN', 'AMH', 'AMP', 'AMT', 'AMZN',
  'ANSS', 'AON', 'APD', 'ARE', 'ASML', 'AVB', 'AVGO', 'AWK', 'AXP', 'AZO',
  'BA', 'BAC', 'BAX', 'BDX', 'BIIB', 'BK', 'BKR', 'BLK', 'BRK.B', 'BSX',
  'C', 'CAG', 'CAH', 'CARR', 'CAT', 'CB', 'CCI', 'CDNS', 'CDW', 'CE',
  'CHD', 'CHRW', 'CI', 'CINF', 'CL', 'CME', 'CMI', 'CNC', 'CNQ', 'COF',
  'COP', 'COR', 'COST', 'CPB', 'CRM', 'CSCO', 'CSGP', 'CSL', 'CTRA', 'CTSH',
  'CTVA', 'CVE', 'CVS', 'CVX', 'D', 'DAL', 'DD', 'DE', 'DFS', 'DG',
  'DHR', 'DLR', 'DLTR', 'DOW', 'DUK', 'DVN', 'DXCM', 'ECL', 'ED', 'EG',
  'EL', 'ELV', 'EMN', 'EMR', 'ENB', 'EOG', 'EPAM', 'EPD', 'EQIX', 'EQR',
  'EQT', 'ES', 'ETN', 'EW', 'EXC', 'EXPD', 'EXR', 'FANG', 'FAST', 'FCX',
  'FDX', 'FI', 'FITB', 'FMC', 'FTNT', 'GD', 'GE', 'GIS', 'GL', 'GOOG',
  'GOOGL', 'GS', 'GWW', 'HAL', 'HCA', 'HD', 'HES', 'HIG', 'HOLX', 'HON',
  'HOOD', 'HSY', 'HUM', 'HWM', 'IBM', 'ICE', 'IDXX', 'INTC', 'INTU', 'INVH',
  'IQV', 'ISRG', 'IT', 'ITW', 'JBHT', 'JBL', 'JCI', 'JNJ', 'JPM', 'K',
  'KDP', 'KHC', 'KLAC', 'KMB', 'KMI', 'KO', 'KR', 'LDOS', 'LIN', 'LLY',
  'LMT', 'LNG', 'LRCX', 'LULU', 'LUV', 'LW', 'LYB', 'MA', 'MAA', 'MCD',
  'MCHP', 'MCK', 'MDLZ', 'MDT', 'MET', 'META', 'MKC', 'MLM', 'MMC', 'MNST',
  'MO', 'MPC', 'MRK', 'MRO', 'MS', 'MSFT', 'MTB', 'MTD', 'MU', 'NEE',
  'NEM', 'NFLX', 'NKE', 'NOC', 'NOW', 'NTAP', 'NTRS', 'NUE', 'NVDA', 'NXPI',
  'O', 'ODFL', 'OKE', 'ORCL', 'ORLY', 'OTIS', 'OXY', 'PANW', 'PBA', 'PCAR',
  'PEG', 'PEP', 'PFE', 'PG', 'PGR', 'PLD', 'PM', 'PNC', 'PPG', 'PRU',
  'PSA', 'PSX', 'PTC', 'PWR', 'PXD', 'QCOM', 'REGN', 'RJF', 'RMD', 'ROK',
  'ROP', 'ROST', 'RS', 'RTX', 'SBUX', 'SCHW', 'SHW', 'SJM', 'SLB', 'SNPS',
  'SO', 'SOFI', 'SPG', 'SPGI', 'SRE', 'STE', 'STLD', 'STT', 'STX', 'STZ',
  'SU', 'SYF', 'SYK', 'TAP', 'TFC', 'TFX', 'TGT', 'TJX', 'TMO', 'TRGP',
  'TRV', 'TSCO', 'TT', 'TTWO', 'TXN', 'TXT', 'TYL', 'UAL', 'UNH', 'UNP',
  'UPS', 'URI', 'USB', 'V', 'VLO', 'VMC', 'VRTX', 'VTR', 'WAT', 'WDC',
  'WEC', 'WELL', 'WFC', 'WMB', 'WMT', 'WST', 'XEL', 'XOM', 'YUM', 'ZBH',
  'ZTS'
]);

export function isBigPlayer(ticker: string): boolean {
  if (!ticker) return false;
  return BIG_PLAYERS.has(ticker.trim().toUpperCase());
}

/**
 * Big player when market cap ≥ $10B (self-maintaining — the static list above
 * rots as companies are acquired/delisted), falling back to the list when the
 * cap is unknown.
 */
export function isBigPlayerByCap(ticker: string, marketCap?: number): boolean {
  if (marketCap != null && marketCap >= 10_000_000_000) return true;
  return isBigPlayer(ticker);
}
