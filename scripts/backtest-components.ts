/*
 * Component alpha analysis — which parts of the conviction score actually
 * predict outperformance vs SPY, component by component.
 *
 * For each scoring component (rank weight, buy size, cluster, transaction
 * type, earnings timing, options score, options sentiment, combo, freshness,
 * VIX, track record, valuation) this script runs:
 *   1. an ISOLATION test — observations bucketed by that component's value
 *      alone (any isolated score built from one component is a monotone
 *      transform of its value, so bucketing/ranking by the value IS the
 *      isolation test), with 5/10/20-day forward alpha per bucket;
 *   2. a REMOVAL test — the composite score reconstructed with vs without the
 *      component (neutralized), comparing rank IC against forward alpha.
 *
 * Run (preferred — matches the repo's Electron-ABI better-sqlite3 build):
 *     npm run backtest:components
 * Also runs under plain Node / ts-node:
 *     npx ts-node scripts/backtest-components.ts
 * better-sqlite3 in this repo is compiled for Electron's ABI; if it fails to
 * load under plain Node the script degrades to EDGAR-only mode (insider-side
 * components still measured) and says so in the report.
 *
 * Data: local signals DB (opened READ-ONLY — this script never writes to it),
 * SEC EDGAR daily Form 4 indexes, Yahoo Finance ADJUSTED closes only (F15:
 * raw and adjusted prices are never mixed; observations with no adjusted
 * price for a required window are skipped, never forward-filled).
 *
 * Statistical protocol — fixed BEFORE reading any data (no snooping):
 *   - F31 fix: one observation per ticker per calendar day (highest-scored
 *     scrape wins), then a >= 5-day gap between kept observations of the same
 *     ticker to break autocorrelation.
 *   - >= 30 independent observations per component, with real cross-sectional
 *     variation (minority-value count >= 8), else "insufficient data".
 *   - Spearman rank correlation (returns are not normal). IC == Spearman of
 *     component value vs forward alpha; the 10-day horizon is the headline.
 *   - Welch t-test on the top-vs-bottom bucket 10-day alpha spread.
 *   - Walk-forward: chronological 70/30 split; in-sample and out-of-sample IC
 *     reported separately. Verdict thresholds are the constants below.
 *
 * Env knobs: BACKTEST_DB (explicit DB path), EDGAR_LOOKBACK_DAYS (default
 * 365), EDGAR_MAX_FILINGS (default 400), EDGAR_SAMPLE_DAYS (default 48).
 *
 * Output: backtest-components-report.md in the project root.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { XMLParser } from 'fast-xml-parser';
import {
  classifyTransaction,
  daysBetween,
  getFreshnessMultiplier,
  type OptionsActivity,
  type RawInsiderTrade,
  type ScoreBreakdown,
} from '../src/types';
import { getRankWeight, getDollarVolumePoints, SCORE_HALF_SATURATION } from '../electron/scoring';
import { mapOwnershipDocument } from '../electron/scraper/edgar';

// ──────────────────────────────────────────────────────────────────────────
// Protocol constants — the entire test design, fixed up-front.
// ──────────────────────────────────────────────────────────────────────────

const HORIZONS = [5, 10, 20] as const;
const PRIMARY_H = 10;
const MIN_OBS = 30; // per component
const MIN_MINORITY = 8; // variation guard: obs not at the modal value
const IC_MEANINGFUL = 0.05;
const IC_STRONG = 0.1;
const P_MAX = 0.05;
const OOS_COLLAPSE = 0.02; // |IC_oos| below this after a meaningful IC_is = noise
const MIN_OOS = 10; // min out-of-sample observations for a walk-forward split
const TRAIN_FRACTION = 0.7;
const DEDUP_MIN_GAP_DAYS = 5;
const RIPENESS_DAYS = 27; // 20d horizon + 5d exit search + buffer
const ENTRY_SEARCH_DAYS = 4; // max forward search for an entry trading day
const EXIT_SEARCH_DAYS = 5; // max forward search for an exit trading day

const EDGAR_LOOKBACK_DAYS = envInt('EDGAR_LOOKBACK_DAYS', 365);
const EDGAR_MAX_FILINGS = envInt('EDGAR_MAX_FILINGS', 400);
const EDGAR_SAMPLE_DAYS = envInt('EDGAR_SAMPLE_DAYS', 48);

const YF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SEC_UA = 'insider-whale-terminal-backtest/1.0 (marcel.rogls@gmail.com)';

type ComponentKey =
  | 'rankWeight'
  | 'dollarVolume'
  | 'cluster'
  | 'txType'
  | 'earningsTiming'
  | 'optionsScore'
  | 'optionsSentiment'
  | 'combo'
  | 'freshness'
  | 'vix'
  | 'trackRecord'
  | 'valuation';

interface ComponentMeta {
  key: ComponentKey;
  label: string;
  source: string;
  /** Participates multiplicatively/additively in the composite reconstruction. */
  inFormula: boolean;
  /** Neutral value used by the removal test (median for point scales). */
  neutral: (sampleValues: number[]) => number;
  location: string;
  raise: string;
  lower: string;
  neutralize: string;
}

const one = (): number => 1;
const zero = (): number => 0;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 1;
};

/** All 12 component tests, defined up-front. */
const COMPONENTS: readonly ComponentMeta[] = [
  {
    key: 'rankWeight',
    label: 'Insider rank weighting',
    source: 'breakdown.rankWeight (DB) / getRankWeight(role) (EDGAR)',
    inFormula: true,
    neutral: median,
    location: 'getRankWeight — electron/scoring.ts',
    raise: 'widen the top-rank separation (e.g. CEO 10 → 12, keep "other" at 1)',
    lower: 'compress weights toward the 3–6 band (e.g. CEO 10 → 7, Dir 4 → 4)',
    neutralize: 'return a constant weight 5 for every role',
  },
  {
    key: 'dollarVolume',
    label: 'Buy sizing (dollar-volume points)',
    source: 'breakdown.dollarVolumePoints (DB) / getDollarVolumePoints(value) (EDGAR; absolute buckets — market cap was not persisted historically)',
    inFormula: true,
    neutral: median,
    location: 'getDollarVolumePoints — electron/scoring.ts',
    raise: 'steepen the buckets (top bucket 20 → 26, floor stays 1)',
    lower: 'flatten the buckets (20 → 14, 14 → 11, 10 → 9)',
    neutralize: 'return a constant 10 points regardless of size',
  },
  {
    key: 'cluster',
    label: 'Cluster detection',
    source: 'breakdown.clusterMultiplier (DB only)',
    inFormula: true,
    neutral: one,
    location: 'getClusterMultiplier — electron/scoring.ts',
    raise: 'raise the 4+ insider ceiling 3.0 → 3.5',
    lower: 'cap the multiplier at 2.0 (4+ insiders 3.0 → 2.0)',
    neutralize: 'return 1.0 for any insider count',
  },
  {
    key: 'txType',
    label: 'Transaction-type weighting',
    source: 'breakdown.typeModifier (DB) / classifyTransaction(type).modifier (EDGAR)',
    inFormula: true,
    neutral: one,
    location: 'classifyTransaction — src/types/index.ts',
    raise: 'sharpen the contrast (10b5-1 buy 0.4 → 0.25, exercise-hold 0.5 → 0.35)',
    lower: 'raise the reduced tiers toward 1.0 (10b5-1 buy 0.4 → 0.7)',
    neutralize: 'set every scoring-eligible type to modifier 1.0',
  },
  {
    key: 'earningsTiming',
    label: 'Earnings timing multiplier (insider leg)',
    source: 'breakdown.timingMultiplier (DB only)',
    inFormula: true,
    neutral: one,
    location: 'getInsiderTimingMultiplier — electron/scoring.ts',
    raise: 'boost the ≤5d bucket 1.8 → 2.1 (finance-insider kicker unchanged)',
    lower: 'soften the buckets (1.8 → 1.4, 1.5 → 1.25, 1.3 → 1.15)',
    neutralize: 'return 1.0 regardless of days-to-earnings',
  },
  {
    key: 'optionsScore',
    label: 'Options scoring (net detailed score)',
    source: 'breakdown.optionsScore (DB only)',
    inFormula: true,
    neutral: zero,
    location: 'scoreOptionsDetailed / scoreOneOption — electron/scoring.ts',
    raise: 'raise the premium-tier base points (18 → 22 for >$2M prints)',
    lower: 'lower the premium-tier base points (18 → 12) and cap multipliers',
    neutralize: 'return 0 — options contribute nothing to the composite',
  },
  {
    key: 'optionsSentiment',
    label: 'Options sentiment (C/P direction)',
    source: 'bullish premium share of options_activity JSON (DB only; 0..1)',
    inFormula: false, // enters the formula only through optionsScore's sign
    neutral: one,
    location: 'sentiment normalization — electron/scraper/optionsMap.ts',
    raise: 'weight the bearish leg harder in scoreOptionsDetailed (subtract 1.25× bearScore)',
    lower: 'dampen the directional split (subtract only 0.5× bearScore)',
    neutralize: 'ignore sentiment — score magnitude only',
  },
  {
    key: 'combo',
    label: 'Combo detection bonus',
    source: 'breakdown.comboBonus (DB only; 0 or 30)',
    inFormula: true,
    neutral: zero,
    location: 'COMBO_BONUS / detectCombo — electron/scoring.ts',
    raise: 'COMBO_BONUS 30 → 35',
    lower: 'COMBO_BONUS 30 → 15',
    neutralize: 'COMBO_BONUS 30 → 0',
  },
  {
    key: 'freshness',
    label: 'Freshness / time decay',
    source: 'breakdown.freshnessMultiplier (DB) / filing-lag decay (EDGAR)',
    inFormula: true,
    neutral: one,
    location: 'getFreshnessMultiplier — src/types/index.ts',
    raise: 'decay faster (exp rate −0.115 → −0.155)',
    lower: 'decay slower (exp rate −0.115 → −0.08)',
    neutralize: 'return 1.0 at any age',
  },
  {
    key: 'vix',
    label: 'VIX boost',
    source: 'breakdown.vixMultiplier (DB only)',
    inFormula: true,
    neutral: one,
    location: 'getVixMultiplier — electron/scoring.ts',
    raise: 'raise the ramp cap 1.15 → 1.25',
    lower: 'lower the ramp cap 1.15 → 1.05',
    neutralize: 'return 1.0 at any VIX',
  },
  {
    key: 'trackRecord',
    label: 'Insider track record (shrunk win rate)',
    source: 'breakdown.trackRecordMultiplier (DB only)',
    inFormula: true,
    neutral: one,
    location: 'getTrackRecordMultiplier — electron/scoring.ts',
    raise: 'steepen the slope (0.65 → 0.9, clamp unchanged)',
    lower: 'flatten the slope (0.65 → 0.4)',
    neutralize: 'return 1.0 regardless of the record',
  },
  {
    key: 'valuation',
    label: 'Valuation multiplier',
    source: 'parsed from breakdown.notes ("(×1.15)" etc.; DB only — the multiplier itself is not persisted)',
    inFormula: true,
    neutral: one,
    location: 'getValuationMultiplier — electron/scoring.ts',
    raise: 'raise the deep-undervaluation tier 1.15 → 1.25',
    lower: 'soften the tiers (1.15 → 1.08, 1.08 → 1.04)',
    neutralize: 'return 1.0 at any upside',
  },
] as const;

// ──────────────────────────────────────────────────────────────────────────
// Small utilities
// ──────────────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD → UTC ms (calendar arithmetic; immune to DST). */
function ymdUtcMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** YYYY-MM-DD → local-midnight ms (matches src/types daysBetween semantics). */
function ymdLocalMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function addDaysYmd(s: string, days: number): string {
  const ms = ymdUtcMs(s) + days * 86_400_000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Whole calendar days b − a. */
function diffDaysYmd(a: string, b: string): number {
  return Math.round((ymdUtcMs(b) - ymdUtcMs(a)) / 86_400_000);
}

/** Deterministic LCG so EDGAR sampling is reproducible run-to-run. */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function variance(xs: readonly number[], m: number): number {
  if (xs.length < 2) return 0;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
}

// ──────────────────────────────────────────────────────────────────────────
// Statistics — Spearman, Welch t, Student-t p-values (no external libs)
// ──────────────────────────────────────────────────────────────────────────

/** 1-based ranks with average ranks for ties. */
function tieRanks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

function spearman(xs: readonly number[], ys: readonly number[]): number {
  return pearson(tieRanks(xs), tieRanks(ys));
}

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lgamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Continued fraction for the regularized incomplete beta (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for a Student-t statistic. */
function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  return Math.min(1, ibeta(df / 2, 0.5, df / (df + t * t)));
}

function welch(a: readonly number[], b: readonly number[]): { t: number; df: number; p: number } {
  if (a.length < 2 || b.length < 2) return { t: 0, df: 0, p: 1 };
  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = variance(a, m1);
  const v2 = variance(b, m2);
  const se2 = v1 / a.length + v2 / b.length;
  if (se2 <= 0) return { t: 0, df: a.length + b.length - 2, p: 1 };
  const t = (m1 - m2) / Math.sqrt(se2);
  const df =
    (se2 * se2) /
    ((v1 * v1) / (a.length * a.length * (a.length - 1)) + (v2 * v2) / (b.length * b.length * (b.length - 1)));
  return { t, df, p: tTwoSidedP(t, df) };
}

function spearmanP(rho: number, n: number): number {
  if (n < 4 || Math.abs(rho) >= 1) return Math.abs(rho) >= 1 && n >= 4 ? 0 : 1;
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return tTwoSidedP(t, n - 2);
}

// ──────────────────────────────────────────────────────────────────────────
// Rate-limited fetch with exponential backoff (max 3 retries)
// ──────────────────────────────────────────────────────────────────────────

let lastFetchAt = 0;
const FETCH_GAP_MS = 160; // global throttle: well under SEC's 10 req/s

async function fetchWithRetry(url: string, headers: Record<string, string>): Promise<Response | null> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const wait = lastFetchAt + FETCH_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return res;
      if (res.status === 404 || res.status === 403) return null; // not retryable
      if (res.status !== 429 && res.status < 500) return null;
    } catch {
      /* network error → retry */
    }
    if (attempt < 3) await sleep(800 * Math.pow(2, attempt)); // 800, 1600, 3200 ms
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Yahoo Finance adjusted closes (adjusted ONLY — never raw; F15)
// ──────────────────────────────────────────────────────────────────────────

interface Series {
  dates: string[]; // sorted YYYY-MM-DD
  px: Map<string, number>;
}

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { adjclose?: Array<{ adjclose?: Array<number | null> }> };
    }>;
  };
}

const seriesCache = new Map<string, Series | null>();
const skippedTickers: string[] = [];

async function fetchSeries(symbol: string, fromYmd: string): Promise<Series | null> {
  const cached = seriesCache.get(symbol);
  if (cached !== undefined) return cached;
  const period1 = Math.floor((ymdUtcMs(fromYmd) - 10 * 86_400_000) / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetchWithRetry(url, { 'User-Agent': YF_UA });
  if (!res) {
    seriesCache.set(symbol, null);
    skippedTickers.push(symbol);
    return null;
  }
  let json: YahooChart;
  try {
    json = (await res.json()) as YahooChart;
  } catch {
    seriesCache.set(symbol, null);
    skippedTickers.push(symbol);
    return null;
  }
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const adj = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const px = new Map<string, number>();
  ts.forEach((t, i) => {
    const v = adj[i];
    if (v != null && Number.isFinite(v) && v > 0) px.set(new Date(t * 1000).toISOString().slice(0, 10), v);
  });
  if (px.size === 0) {
    // No ADJUSTED series → skip the ticker entirely rather than fall back to raw closes.
    seriesCache.set(symbol, null);
    skippedTickers.push(symbol);
    return null;
  }
  const series: Series = { dates: [...px.keys()].sort(), px };
  seriesCache.set(symbol, series);
  return series;
}

/** First trading date >= target within maxDays, else null (binary search). */
function firstOnOrAfter(series: Series, target: string, maxDays: number): string | null {
  const { dates } = series;
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= dates.length) return null;
  const d = dates[lo];
  return diffDaysYmd(target, d) <= maxDays ? d : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Observations
// ──────────────────────────────────────────────────────────────────────────

interface Observation {
  ticker: string;
  date: string; // decision date (YYYY-MM-DD)
  score: number; // dedup preference within a ticker-day
  fromDb: boolean;
  components: Partial<Record<ComponentKey, number>>;
  optionsTiming: number; // reconstruction input (1.0 when unknown)
  alpha?: Record<number, number>; // horizon → alpha %
}

// ── DB loading (read-only) ──

interface SqliteStatement {
  all(): unknown[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteCtor = new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => SqliteDb;

interface DbSignalRow {
  ticker: string;
  score: number;
  scraped_at: string;
  options_activity: string | null;
  score_breakdown: string | null;
}

function safeJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function findDbPath(): string | null {
  const appData = process.env.APPDATA ?? '';
  const candidates = [
    process.env.BACKTEST_DB,
    appData && path.join(appData, 'Insider & Whale Terminal', 'insider-tracker.db'),
    appData && path.join(appData, 'insider-whale-terminal', 'insider-tracker.db'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function loadDbObservations(): { obs: Observation[]; note: string } {
  const dbPath = findDbPath();
  if (!dbPath) return { obs: [], note: 'No local signals DB found (set BACKTEST_DB to override).' };

  let Ctor: SqliteCtor;
  try {
    const req = createRequire(__filename);
    Ctor = req('better-sqlite3') as SqliteCtor;
  } catch (err) {
    return {
      obs: [],
      note:
        'better-sqlite3 failed to load under this runtime (it is built for the Electron ABI) — ' +
        'DB observations skipped. Run `npm run backtest:components` for the full analysis. ' +
        `[${err instanceof Error ? err.message.split('\n')[0] : String(err)}]`,
    };
  }

  const db = new Ctor(dbPath, { readonly: true, fileMustExist: true }); // READ-ONLY
  let rows: DbSignalRow[];
  try {
    rows = db
      .prepare(`SELECT ticker, score, scraped_at, options_activity, score_breakdown FROM signals ORDER BY scraped_at ASC`)
      .all() as unknown as DbSignalRow[];
  } finally {
    db.close();
  }

  const obs: Observation[] = [];
  for (const row of rows) {
    if (!row.ticker || !row.scraped_at) continue;
    const b = safeJson<ScoreBreakdown>(row.score_breakdown);
    if (!b) continue;
    const components: Partial<Record<ComponentKey, number>> = {};
    const put = (k: ComponentKey, v: number | undefined): void => {
      if (v !== undefined) components[k] = v;
    };
    put('rankWeight', finite(b.rankWeight));
    put('dollarVolume', finite(b.dollarVolumePoints));
    put('cluster', finite(b.clusterMultiplier));
    put('txType', finite(b.typeModifier));
    put('earningsTiming', finite(b.timingMultiplier));
    put('optionsScore', finite(b.optionsScore));
    put('combo', finite(b.comboBonus));
    put('freshness', finite(b.freshnessMultiplier));
    put('vix', finite(b.vixMultiplier));
    put('trackRecord', finite(b.trackRecordMultiplier));

    // Valuation multiplier is not persisted as a field — recover it from the
    // human-readable note scoring emits ("Undervalued (~40% upside, ×1.15)").
    const notes = Array.isArray(b.notes) ? b.notes.join(' | ') : '';
    const valMatch = /(?:Undervalued|Overvalued)[^(]*\(×([0-9.]+)\)/.exec(notes);
    put('valuation', valMatch ? finite(parseFloat(valMatch[1])) ?? 1 : 1);

    // Options sentiment: bullish share of total options premium (only defined
    // when the signal actually carried options flow).
    const options = safeJson<OptionsActivity[]>(row.options_activity) ?? [];
    let bull = 0;
    let bear = 0;
    for (const o of options) {
      const prem = finite(o.premiumTotal) ?? finite(o.notional) ?? 0;
      if (o.sentiment === 'bullish') bull += prem;
      else if (o.sentiment === 'bearish') bear += prem;
    }
    if (bull + bear > 0) put('optionsSentiment', bull / (bull + bear));

    obs.push({
      ticker: row.ticker.toUpperCase(),
      date: row.scraped_at.slice(0, 10),
      score: finite(row.score) ?? 0,
      fromDb: true,
      components,
      optionsTiming: finite(b.optionsTimingMultiplier) ?? 1,
    });
  }
  return { obs, note: `Loaded ${obs.length} raw signal rows from ${dbPath}.` };
}

// ── EDGAR augmentation (insider-side components only) ──

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

interface EdgarIndexJson {
  directory?: { item?: Array<{ name?: string }> | { name?: string } };
}

async function loadEdgarObservations(endYmd: string): Promise<{ obs: Observation[]; note: string }> {
  const startYmd = addDaysYmd(ymdOf(new Date()), -EDGAR_LOOKBACK_DAYS);
  // Enumerate weekdays in [start, end], then sample evenly for a bounded run.
  const weekdays: string[] = [];
  for (let d = startYmd; d <= endYmd; d = addDaysYmd(d, 1)) {
    const dow = new Date(ymdUtcMs(d)).getUTCDay();
    if (dow !== 0 && dow !== 6) weekdays.push(d);
  }
  const step = Math.max(1, Math.floor(weekdays.length / EDGAR_SAMPLE_DAYS));
  const sampledDays = weekdays.filter((_, i) => i % step === 0).slice(0, EDGAR_SAMPLE_DAYS);
  const perDay = Math.max(1, Math.ceil(EDGAR_MAX_FILINGS / Math.max(1, sampledDays.length)));
  const rng = makeLcg(42); // fixed seed → reproducible sample, no snooping

  const obs: Observation[] = [];
  let filingsFetched = 0;
  let daysWithIndex = 0;

  for (const day of sampledDays) {
    if (filingsFetched >= EDGAR_MAX_FILINGS) break;
    const [y, mo] = [day.slice(0, 4), Number(day.slice(5, 7))];
    const qtr = Math.floor((mo - 1) / 3) + 1;
    const idxUrl = `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${qtr}/form.${day.replace(/-/g, '')}.idx`;
    const res = await fetchWithRetry(idxUrl, { 'User-Agent': SEC_UA });
    if (!res) continue; // holiday / not yet published
    daysWithIndex++;
    const text = await res.text();

    const filings: Array<{ cik: string; accession: string }> = [];
    for (const line of text.split('\n')) {
      if (!/^4\s{2,}/.test(line)) continue; // Form 4 exactly (skips 4/A and the header)
      const m = /edgar\/data\/(\d+)\/([0-9-]{18,25})\.txt\s*$/.exec(line.trim());
      if (m) filings.push({ cik: m[1], accession: m[2] });
    }
    // Random sample without replacement (deterministic LCG).
    const picks: Array<{ cik: string; accession: string }> = [];
    const pool = [...filings];
    while (picks.length < perDay && pool.length > 0) {
      const i = Math.floor(rng() * pool.length);
      picks.push(pool.splice(i, 1)[0]);
    }

    for (const f of picks) {
      if (filingsFetched >= EDGAR_MAX_FILINGS) break;
      filingsFetched++;
      const folder = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.accession.replace(/-/g, '')}`;
      const idxRes = await fetchWithRetry(`${folder}/index.json`, { 'User-Agent': SEC_UA });
      if (!idxRes) continue;
      let items: Array<{ name?: string }> = [];
      try {
        const parsed = (await idxRes.json()) as EdgarIndexJson;
        const raw = parsed.directory?.item;
        items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      } catch {
        continue;
      }
      const xmlItem = items.find((it) => typeof it.name === 'string' && /\.xml$/i.test(it.name));
      if (!xmlItem?.name) continue;
      const xmlRes = await fetchWithRetry(`${folder}/${xmlItem.name}`, { 'User-Agent': SEC_UA });
      if (!xmlRes) continue;
      let trades: RawInsiderTrade[] = [];
      try {
        const doc: unknown = xmlParser.parse(await xmlRes.text());
        trades = mapOwnershipDocument(doc, {
          cik: f.cik,
          accession: f.accession,
          indexUrl: `${folder}/${f.accession}-index.htm`,
          filingDate: day,
        });
      } catch {
        continue;
      }
      for (const t of trades) {
        if (!(t.value > 0)) continue; // no usable price in the XML → skip, don't approximate
        const components: Partial<Record<ComponentKey, number>> = {
          rankWeight: getRankWeight(t.role).weight,
          dollarVolume: getDollarVolumePoints(t.value), // absolute buckets — cap unknown
          txType: classifyTransaction(t.transactionType).modifier,
        };
        // Freshness at the decision point = filing-lag age of the trade.
        const age = daysBetween(t.tradeDate, ymdLocalMs(day));
        if (age != null && age >= 0) components.freshness = getFreshnessMultiplier(age);
        obs.push({
          ticker: t.ticker,
          date: day, // decision date = when the filing became public
          score: t.value,
          fromDb: false,
          components,
          optionsTiming: 1,
        });
      }
    }
  }
  return {
    obs,
    note:
      `EDGAR: sampled ${sampledDays.length} weekdays (${daysWithIndex} with an index) over the last ` +
      `${EDGAR_LOOKBACK_DAYS} days, fetched ${filingsFetched} Form 4 filings → ${obs.length} open-market purchases. ` +
      `Cluster/options/VIX/track-record/valuation are not derivable from a sampled EDGAR slice and are left unset.`,
  };
}

// ── Deduplication (F31 fix) ──

function dedupObservations(all: Observation[]): { kept: Observation[]; rawCount: number; dailyCount: number } {
  const rawCount = all.length;
  // 1. One observation per ticker per calendar day — DB rows beat EDGAR rows
  //    (they carry all components); otherwise the highest score wins.
  const byTickerDay = new Map<string, Observation>();
  for (const o of all) {
    const key = `${o.ticker}|${o.date}`;
    const prev = byTickerDay.get(key);
    if (!prev || (o.fromDb && !prev.fromDb) || (o.fromDb === prev.fromDb && o.score > prev.score)) {
      byTickerDay.set(key, o);
    }
  }
  const daily = [...byTickerDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // 2. Minimum 5-day holding period between observations of the same ticker.
  const lastKept = new Map<string, string>();
  const kept: Observation[] = [];
  for (const o of daily) {
    const last = lastKept.get(o.ticker);
    if (last !== undefined && diffDaysYmd(last, o.date) < DEDUP_MIN_GAP_DAYS) continue;
    lastKept.set(o.ticker, o.date);
    kept.push(o);
  }
  return { kept, rawCount, dailyCount: daily.length };
}

// ── Forward alpha ──

async function attachAlpha(observations: Observation[]): Promise<{ withAlpha: Observation[]; skippedWindows: number }> {
  if (observations.length === 0) return { withAlpha: [], skippedWindows: 0 };
  const earliest = observations[0].date;
  const spy = await fetchSeries('SPY', earliest);
  if (!spy) throw new Error('SPY adjusted-close history unavailable — cannot compute alpha.');

  const tickers = [...new Set(observations.map((o) => o.ticker))];
  console.log(`Fetching adjusted closes for ${tickers.length} tickers + SPY…`);
  let done = 0;
  for (const t of tickers) {
    await fetchSeries(t, earliest);
    if (++done % 25 === 0) console.log(`  …${done}/${tickers.length}`);
  }

  let skippedWindows = 0;
  const withAlpha: Observation[] = [];
  for (const o of observations) {
    const series = seriesCache.get(o.ticker);
    if (!series) {
      skippedWindows++;
      continue;
    }
    const entryDate = firstOnOrAfter(series, o.date, ENTRY_SEARCH_DAYS);
    const entryPx = entryDate ? series.px.get(entryDate) : undefined;
    const spyEntry = entryDate ? spy.px.get(entryDate) : undefined;
    if (!entryDate || entryPx === undefined || spyEntry === undefined) {
      skippedWindows++;
      continue;
    }
    const alpha: Record<number, number> = {};
    let ok = true;
    for (const h of HORIZONS) {
      const exitDate = firstOnOrAfter(series, addDaysYmd(entryDate, h), EXIT_SEARCH_DAYS);
      const exitPx = exitDate ? series.px.get(exitDate) : undefined;
      const spyExit = exitDate ? spy.px.get(exitDate) : undefined;
      if (!exitDate || exitPx === undefined || spyExit === undefined) {
        ok = false;
        break;
      }
      alpha[h] = (exitPx / entryPx - 1) * 100 - (spyExit / spyEntry - 1) * 100;
    }
    if (!ok) {
      skippedWindows++;
      continue; // uniform sample: every kept observation has all three horizons
    }
    o.alpha = alpha;
    withAlpha.push(o);
  }
  return { withAlpha, skippedWindows };
}

// ──────────────────────────────────────────────────────────────────────────
// Component analysis
// ──────────────────────────────────────────────────────────────────────────

interface BucketRow {
  label: string;
  n: number;
  meanAlpha: Record<number, number>;
}

interface ComponentResult {
  meta: ComponentMeta;
  n: number;
  sufficient: boolean;
  insufficiencyReason: string;
  buckets: BucketRow[];
  spear: Record<number, { rho: number; p: number }>;
  icIS: number | null;
  icOOS: number | null;
  isN: number;
  oosN: number;
  spread: { diff: number; t: number; p: number };
  verdict: string;
}

function analyzeComponent(meta: ComponentMeta, observations: Observation[]): ComponentResult {
  // Sample: chronologically ordered observations where this component is defined.
  const sample = observations.filter((o) => o.components[meta.key] !== undefined && o.alpha !== undefined);
  const values = sample.map((o) => o.components[meta.key] as number);
  const alphaAt = (h: number): number[] => sample.map((o) => (o.alpha as Record<number, number>)[h]);

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const modalCount = Math.max(0, ...counts.values());
  const minority = sample.length - modalCount;

  const empty: ComponentResult = {
    meta,
    n: sample.length,
    sufficient: false,
    insufficiencyReason: '',
    buckets: [],
    spear: {},
    icIS: null,
    icOOS: null,
    isN: 0,
    oosN: 0,
    spread: { diff: 0, t: 0, p: 1 },
    verdict: 'Insufficient data',
  };
  if (sample.length < MIN_OBS) {
    empty.insufficiencyReason = `n=${sample.length} < ${MIN_OBS} independent observations`;
    return empty;
  }
  if (counts.size < 2 || minority < MIN_MINORITY) {
    empty.insufficiencyReason = `no usable cross-sectional variation (${counts.size} distinct value(s), minority n=${minority} < ${MIN_MINORITY})`;
    empty.verdict = 'Insufficient variation';
    return empty;
  }

  // Buckets: exact-value groups when the component is discrete (≤ 4 distinct
  // values, e.g. combo 0/30 or cluster 1/1.5/2/3), else count-quartiles.
  const buckets: BucketRow[] = [];
  let topIdx: number[] = [];
  let bottomIdx: number[] = [];
  if (counts.size <= 4) {
    const distinct = [...counts.keys()].sort((a, b) => a - b);
    distinct.forEach((v, bi) => {
      const idxs = sample.map((_, i) => i).filter((i) => values[i] === v);
      const meanAlpha: Record<number, number> = {};
      for (const h of HORIZONS) meanAlpha[h] = mean(idxs.map((i) => alphaAt(h)[i]));
      buckets.push({ label: `V${bi + 1} (=${v})`, n: idxs.length, meanAlpha });
      if (bi === 0) bottomIdx = idxs;
      if (bi === distinct.length - 1) topIdx = idxs;
    });
  } else {
    const order = sample.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
    const q = Math.floor(order.length / 4);
    const cuts = [0, q, 2 * q, 3 * q, order.length];
    for (let b = 0; b < 4; b++) {
      const idxs = order.slice(cuts[b], cuts[b + 1]);
      const meanAlpha: Record<number, number> = {};
      for (const h of HORIZONS) meanAlpha[h] = mean(idxs.map((i) => alphaAt(h)[i]));
      buckets.push({ label: `Q${b + 1}`, n: idxs.length, meanAlpha });
      if (b === 0) bottomIdx = idxs;
      if (b === 3) topIdx = idxs;
    }
  }

  const spear: Record<number, { rho: number; p: number }> = {};
  for (const h of HORIZONS) {
    const rho = spearman(values, alphaAt(h));
    spear[h] = { rho, p: spearmanP(rho, sample.length) };
  }

  // Walk-forward 70/30 (sample is chronological because `observations` is).
  const split = Math.floor(sample.length * TRAIN_FRACTION);
  const oosN = sample.length - split;
  const a10 = alphaAt(PRIMARY_H);
  let icIS: number | null = null;
  let icOOS: number | null = null;
  if (split >= MIN_OOS && oosN >= MIN_OOS) {
    icIS = spearman(values.slice(0, split), a10.slice(0, split));
    icOOS = spearman(values.slice(split), a10.slice(split));
  }

  const topAlpha = topIdx.map((i) => a10[i]);
  const bottomAlpha = bottomIdx.map((i) => a10[i]);
  const w = welch(topAlpha, bottomAlpha);
  const spread = { diff: mean(topAlpha) - mean(bottomAlpha), t: w.t, p: w.p };

  // Verdict — rules fixed up-front (see protocol constants).
  let verdict: string;
  if (icIS !== null && icOOS !== null) {
    if (icOOS >= IC_MEANINGFUL && icIS > 0 && spread.p < P_MAX) verdict = 'Drives alpha';
    else if (icOOS <= -IC_MEANINGFUL && spread.p < P_MAX) verdict = 'Negative';
    else if (Math.abs(icIS) >= IC_MEANINGFUL && (Math.sign(icIS) !== Math.sign(icOOS) || Math.abs(icOOS) < OOS_COLLAPSE))
      verdict = 'Noise (collapses out-of-sample)';
    else verdict = 'Neutral';
  } else {
    const rho = spear[PRIMARY_H].rho;
    if (rho >= IC_MEANINGFUL && spread.p < P_MAX) verdict = 'Drives alpha (no OOS split)';
    else if (rho <= -IC_MEANINGFUL && spread.p < P_MAX) verdict = 'Negative (no OOS split)';
    else verdict = 'Neutral (no OOS split)';
  }

  return {
    meta,
    n: sample.length,
    sufficient: true,
    insufficiencyReason: '',
    buckets,
    spear,
    icIS,
    icOOS,
    isN: split,
    oosN,
    spread,
    verdict,
  };
}

// ── Removal test — composite reconstructed with vs without each component ──

interface RemovalRow {
  key: ComponentKey;
  label: string;
  icWith: number;
  icWithout: number;
  deltaIC: number;
  applicable: boolean;
}

const FORMULA_KEYS: readonly ComponentKey[] = [
  'rankWeight',
  'dollarVolume',
  'txType',
  'cluster',
  'earningsTiming',
  'vix',
  'optionsScore',
  'freshness',
  'trackRecord',
  'valuation',
  'combo',
];

function reconstructScore(o: Observation, overrides: Partial<Record<ComponentKey, number>>): number {
  const g = (k: ComponentKey): number => overrides[k] ?? o.components[k] ?? (k === 'optionsScore' || k === 'combo' ? 0 : 1);
  const insiderRaw = g('rankWeight') * g('dollarVolume') * g('txType') * g('cluster') * g('earningsTiming') * g('vix');
  const optionsRaw = g('optionsScore') * o.optionsTiming;
  // Options freshness ≈ 1.0: options were scraped live, and the per-leg options
  // age is not persisted in the breakdown.
  const combined = (insiderRaw * g('freshness') + optionsRaw) * g('trackRecord') * g('valuation');
  const pos = Math.max(combined, 0);
  const normalized = (pos / (pos + SCORE_HALF_SATURATION)) * 100 + g('combo');
  return Math.min(100, Math.max(0, normalized));
}

function runRemovalTest(observations: Observation[]): { rows: RemovalRow[]; baseIC: number; n: number; sanity: string } {
  // DB observations only — EDGAR rows lack most formula inputs.
  const sample = observations.filter(
    (o) =>
      o.fromDb &&
      o.alpha !== undefined &&
      FORMULA_KEYS.every((k) => o.components[k] !== undefined),
  );
  if (sample.length < MIN_OBS) {
    return { rows: [], baseIC: 0, n: sample.length, sanity: `skipped — only ${sample.length} fully-populated DB observations (< ${MIN_OBS}).` };
  }
  const a10 = sample.map((o) => (o.alpha as Record<number, number>)[PRIMARY_H]);
  const baseScores = sample.map((o) => reconstructScore(o, {}));
  const baseIC = spearman(baseScores, a10);

  // Sanity: reconstruction vs the stored production score (informational —
  // older rows were scored by earlier model versions).
  const stored = sample.map((o) => o.score);
  const sanityRho = spearman(baseScores, stored);
  const sanity = `reconstructed-vs-stored score Spearman = ${sanityRho.toFixed(3)} over n=${sample.length} (differences are expected where rows were scored by older model versions).`;

  const rows: RemovalRow[] = [];
  for (const meta of COMPONENTS) {
    if (!meta.inFormula) {
      rows.push({ key: meta.key, label: meta.label, icWith: baseIC, icWithout: NaN, deltaIC: NaN, applicable: false });
      continue;
    }
    const sampleValues = sample.map((o) => o.components[meta.key] as number);
    const neutral = meta.neutral(sampleValues);
    const removedScores = sample.map((o) => reconstructScore(o, { [meta.key]: neutral }));
    const icWithout = spearman(removedScores, a10);
    rows.push({ key: meta.key, label: meta.label, icWith: baseIC, icWithout, deltaIC: baseIC - icWithout, applicable: true });
  }
  return { rows, baseIC, n: sample.length, sanity };
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');
const f3 = (x: number | null): string => (x !== null && Number.isFinite(x) ? x.toFixed(3) : '—');
const fp = (p: number): string => (Number.isFinite(p) ? (p < 0.001 ? '<0.001' : p.toFixed(3)) : '—');

function recommendation(r: ComponentResult): string {
  const m = r.meta;
  if (!r.sufficient) return `No change — ${r.insufficiencyReason}. Revisit once more history accumulates.`;
  const icRef = r.icOOS ?? r.spear[PRIMARY_H].rho;
  switch (true) {
    case r.verdict.startsWith('Drives alpha') && icRef >= IC_STRONG:
      return `**Increase weight** (${m.location}): ${m.raise}.`;
    case r.verdict.startsWith('Drives alpha'):
      return `Keep — validated. Optional modest increase (${m.location}): ${m.raise}.`;
    case r.verdict.startsWith('Negative'):
      return `**Remove / neutralize** (${m.location}): ${m.neutralize}. The component predicts the wrong direction${r.spread.p < P_MAX ? '' : ' (weak evidence)'}.`;
    case r.verdict.startsWith('Noise'):
      return `**Reduce influence** (${m.location}): ${m.lower}. In-sample edge did not survive out-of-sample.`;
    default:
      return `Keep as-is — no evidence for change (insufficient evidence at p ≥ ${P_MAX} or |IC| < ${IC_MEANINGFUL}).`;
  }
}

function buildReport(args: {
  results: ComponentResult[];
  removal: { rows: RemovalRow[]; baseIC: number; n: number; sanity: string };
  periodStart: string;
  periodEnd: string;
  nObs: number;
  nDb: number;
  nEdgar: number;
  dedupNote: string;
  dbNote: string;
  edgarNote: string;
  skippedWindows: number;
}): string {
  const { results, removal } = args;
  const L: string[] = [];
  L.push('# Component Alpha Analysis');
  L.push('');
  L.push(
    `_Period: ${args.periodStart} → ${args.periodEnd} · n = ${args.nObs} observations (deduplicated: ${args.dedupNote}) · benchmark: SPY (adjusted closes)_`,
  );
  L.push('');
  L.push(`Data: ${args.nDb} observations from the local signals DB, ${args.nEdgar} synthesized from SEC EDGAR Form 4 filings.`);
  L.push(`Horizons: ${HORIZONS.join('/')}-day forward alpha vs SPY. Headline IC = Spearman(component, ${PRIMARY_H}d alpha).`);
  L.push(
    `Verdict thresholds (fixed before analysis): IC ≥ ${IC_MEANINGFUL} meaningful, ≥ ${IC_STRONG} strong; p < ${P_MAX}; ` +
      `walk-forward ${Math.round(TRAIN_FRACTION * 100)}/${Math.round((1 - TRAIN_FRACTION) * 100)} chronological split; ` +
      `min ${MIN_OBS} observations per component.`,
  );
  L.push('');

  // Summary — ranked by out-of-sample IC (fallback: full-sample IC).
  const ranked = [...results].sort((a, b) => {
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
    const ia = a.icOOS ?? a.spear[PRIMARY_H]?.rho ?? -Infinity;
    const ib = b.icOOS ?? b.spear[PRIMARY_H]?.rho ?? -Infinity;
    return ib - ia;
  });
  L.push('## Summary Rankings');
  L.push('');
  L.push('| Rank | Component | n | IC (in-sample) | IC (out-of-sample) | p-value (top vs bottom, 10d) | Verdict |');
  L.push('|---|---|---|---|---|---|---|');
  ranked.forEach((r, i) => {
    const p = r.sufficient ? fp(r.spread.p) + (r.spread.p >= P_MAX ? ' ⚠ insufficient evidence' : '') : '—';
    L.push(`| ${i + 1} | ${r.meta.label} | ${r.n} | ${f3(r.icIS)} | ${f3(r.icOOS)} | ${p} | ${r.verdict} |`);
  });
  L.push('');

  L.push('## Component Details');
  for (const r of results) {
    L.push('');
    L.push(`### ${r.meta.label}`);
    L.push('');
    L.push(`_Source: ${r.meta.source}_ · n = ${r.n}`);
    if (!r.sufficient) {
      L.push('');
      L.push(`**${r.verdict}** — ${r.insufficiencyReason}.`);
      continue;
    }
    L.push('');
    L.push('| Bucket (low → high) | n | α 5d | α 10d | α 20d |');
    L.push('|---|---|---|---|---|');
    for (const b of r.buckets) {
      L.push(`| ${b.label} | ${b.n} | ${f2(b.meanAlpha[5])}% | ${f2(b.meanAlpha[10])}% | ${f2(b.meanAlpha[20])}% |`);
    }
    L.push('');
    const sp = HORIZONS.map((h) => `${h}d: ρ=${f3(r.spear[h].rho)} (p=${fp(r.spear[h].p)})`).join(' · ');
    L.push(`- Spearman: ${sp}`);
    L.push(`- IC in-sample: **${f3(r.icIS)}** (n=${r.isN}) · IC out-of-sample: **${f3(r.icOOS)}** (n=${r.oosN})`);
    L.push(
      `- Top-vs-bottom spread (10d): ${f2(r.spread.diff)}pp, t=${f2(r.spread.t)}, p=${fp(r.spread.p)}` +
        (r.spread.p >= P_MAX ? ' — **insufficient evidence**' : ''),
    );
    L.push(`- **Verdict: ${r.verdict}**`);
  }
  L.push('');

  L.push('## Removal Test (composite with vs without each component)');
  L.push('');
  if (removal.rows.length === 0) {
    L.push(`_${removal.sanity}_`);
  } else {
    L.push(
      `Baseline: composite reconstructed from the persisted per-observation component values (current model formula), IC vs ${PRIMARY_H}d alpha = **${f3(removal.baseIC)}** over n=${removal.n} DB observations. ΔIC > 0 means the component adds predictive rank power to the composite.`,
    );
    L.push('');
    L.push('| Component | IC with | IC without | ΔIC |');
    L.push('|---|---|---|---|');
    for (const row of removal.rows) {
      L.push(
        row.applicable
          ? `| ${row.label} | ${f3(row.icWith)} | ${f3(row.icWithout)} | ${row.deltaIC >= 0 ? '+' : ''}${f3(row.deltaIC)} |`
          : `| ${row.label} | — | — | n/a (enters via options score sign) |`,
      );
    }
    L.push('');
    L.push(`_Sanity: ${removal.sanity}_`);
  }
  L.push('');

  L.push('## Recommended Weight Adjustments');
  L.push('');
  L.push('Mechanically derived from the verdicts via the mapping fixed before the run (no post-hoc tuning):');
  L.push('');
  for (const r of ranked) {
    L.push(`- **${r.meta.label}** — ${recommendation(r)}`);
  }
  L.push('');

  L.push('## Methodology & Caveats');
  L.push('');
  L.push(`- ${args.dbNote}`);
  L.push(`- ${args.edgarNote}`);
  L.push(
    `- Deduplication (F31 fix): ${args.dedupNote}; observations newer than ${RIPENESS_DAYS} days are excluded so every observation has a complete 20-day outcome.`,
  );
  L.push(
    `- Prices: Yahoo adjusted closes ONLY (raw closes are never used — F15). ${args.skippedWindows} observations were dropped for missing price windows; ${skippedTickers.length} ticker(s) had no usable adjusted series${skippedTickers.length ? `: ${[...new Set(skippedTickers)].slice(0, 30).join(', ')}${new Set(skippedTickers).size > 30 ? ', …' : ''}` : ''}.`,
  );
  L.push('- Entry = first trading close on/after the decision date; exits = first trading close on/after entry + horizon.');
  L.push('- The valuation multiplier is recovered from breakdown notes (it is not persisted as a field); it was 1.0 for nearly all historical rows because valuation pre-warm is login-gated.');
  L.push('- The reconstruction uses options-leg freshness = 1.0 (options were scraped live; the per-leg age is not persisted).');
  L.push('- Historical `dollarVolumePoints` reflect absolute buckets: market cap was not populated in production before the F1 fix, and it is not persisted per signal.');
  L.push('- EDGAR-derived observations cover insider-side components only; cluster detection is not measurable on a sampled EDGAR slice.');
  L.push(
    `- Multiple-hypothesis caveat: ${COMPONENTS.length} components at p < ${P_MAX} imply ≈ ${(COMPONENTS.length * P_MAX).toFixed(1)} false positives by chance; treat single-component significance accordingly and re-run as more history accrues.`,
  );
  L.push('');
  L.push(`_Generated ${new Date().toISOString()} by scripts/backtest-components.ts (read-only; no DB writes)._`);
  L.push('');
  return L.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Component alpha analysis — protocol fixed up-front; see header comment.\n');

  const ripeEnd = addDaysYmd(ymdOf(new Date()), -RIPENESS_DAYS);

  const dbLoad = loadDbObservations();
  console.log(dbLoad.note);

  console.log(`Sampling SEC EDGAR Form 4 filings (lookback ${EDGAR_LOOKBACK_DAYS}d, cap ${EDGAR_MAX_FILINGS} filings)…`);
  const edgarLoad = await loadEdgarObservations(ripeEnd);
  console.log(edgarLoad.note);

  const ripe = [...dbLoad.obs, ...edgarLoad.obs].filter((o) => o.date <= ripeEnd);
  const { kept, rawCount, dailyCount } = dedupObservations(ripe);
  const dedupNote = `${rawCount} ripe raw → ${dailyCount} per ticker-day → ${kept.length} after the ${DEDUP_MIN_GAP_DAYS}-day same-ticker gap`;
  console.log(`Dedup: ${dedupNote}.`);
  if (kept.length === 0) {
    console.error('No observations old enough to have outcomes. Re-run later (or raise EDGAR_LOOKBACK_DAYS).');
    process.exit(1);
  }

  const { withAlpha, skippedWindows } = await attachAlpha(kept);
  console.log(`Outcomes: ${withAlpha.length} observations with complete ${HORIZONS.join('/')}d windows (${skippedWindows} skipped).`);
  if (withAlpha.length === 0) {
    console.error('No observations with usable price windows.');
    process.exit(1);
  }

  const results = COMPONENTS.map((meta) => analyzeComponent(meta, withAlpha));
  const removal = runRemovalTest(withAlpha);

  const nDb = withAlpha.filter((o) => o.fromDb).length;
  const report = buildReport({
    results,
    removal,
    periodStart: withAlpha[0].date,
    periodEnd: withAlpha[withAlpha.length - 1].date,
    nObs: withAlpha.length,
    nDb,
    nEdgar: withAlpha.length - nDb,
    dedupNote,
    dbNote: dbLoad.note,
    edgarNote: edgarLoad.note,
    skippedWindows,
  });

  const outPath = path.resolve(process.cwd(), 'backtest-components-report.md');
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(`\nReport written: ${outPath}\n`);

  // Console summary mirror.
  for (const r of [...results].sort((a, b) => (b.icOOS ?? -9) - (a.icOOS ?? -9))) {
    console.log(
      `  ${r.meta.label.padEnd(42)} n=${String(r.n).padStart(4)}  IC(is)=${f3(r.icIS).padStart(6)}  IC(oos)=${f3(r.icOOS).padStart(6)}  ${r.verdict}`,
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error('backtest-components failed:', err);
  process.exit(1);
});
