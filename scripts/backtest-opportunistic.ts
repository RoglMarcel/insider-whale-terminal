/*
 * Routine vs Opportunistic insider classification — dedicated alpha backtest.
 *
 * Tests the Cohen/Malloy/Pomorski hypothesis ("Decoding Inside Information",
 * JF 2012): insiders who DEVIATE from their established calendar pattern
 * (opportunistic buyers) carry materially more forward alpha than insiders who
 * buy on a predictable schedule (routine buyers). This is a standalone check,
 * separate from scripts/backtest-components.ts.
 *
 * Data: the local signals DB (opened READ-ONLY — this script never writes to
 * any table or touches any scraper). Observations come from
 * `insider_track_records`: each record carries a per-insider `pattern`
 * ('routine' | 'opportunistic' | NULL) and a `recent_trades` JSON array of that
 * insider's ripe historical purchases. Role comes from `insider_role`; earnings
 * proximity and market cap are joined (read-only) from `signals` /
 * `ticker_meta` when available. Forward returns are Yahoo Finance ADJUSTED
 * closes only (raw and adjusted are never mixed; an observation with no
 * adjusted price for a required window is skipped, never forward-filled).
 *
 * Run (preferred — better-sqlite3 here is built for the Electron ABI):
 *     npm run backtest:opportunistic
 * Also runs under ts-node/node IF a node-ABI better-sqlite3 is present:
 *     npx ts-node scripts/backtest-opportunistic.ts
 *
 * Statistical protocol — FIXED UP-FRONT (no iterating after seeing results):
 *   - Dedup: one observation per insider per ticker per calendar day, then a
 *     >= 5-day gap between kept observations of the same (insider, ticker) to
 *     break autocorrelation.
 *   - >= 20 observations per group before any conclusion is drawn.
 *   - Spearman IC uses the BINARY opportunistic indicator (1 = opportunistic,
 *     0 = routine): the classifier emits a discrete label, not a confidence
 *     score, so there is nothing continuous to rank — this is stated in the
 *     report rather than fabricating a score.
 *   - Welch's t-test for the group-difference significance (unequal variance).
 *   - Walk-forward: chronological 70 / 30 split; in-sample and out-of-sample
 *     reported separately — a result that only holds in-sample is noise.
 *   - p threshold 0.05; anything above → "insufficient evidence", no conclusion.
 *
 * Env knobs: BACKTEST_DB (explicit DB path).
 * Output: backtest-opportunistic-report.md in the project root.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  classifyTransaction,
  normalizeInsiderName,
  type InsiderHistoricalTrade,
} from '../src/types';
import { getRankWeight } from '../electron/scoring';

// ──────────────────────────────────────────────────────────────────────────
// Protocol constants — the whole test design, fixed before any data is read.
// ──────────────────────────────────────────────────────────────────────────

const HORIZONS = [5, 10, 20, 60] as const;
type Horizon = (typeof HORIZONS)[number];
const PRIMARY_H: Horizon = 20; // headline horizon for the verdict
const MIN_OBS_PER_GROUP = 20;
const MIN_SUBCELL = 20;
const P_MAX = 0.05;
const IC_MEANINGFUL = 0.05;
const IC_STRONG = 0.1;
const DEDUP_MIN_GAP_DAYS = 5;
const TRAIN_FRACTION = 0.7;
const MIN_OOS = 8;
const ENTRY_SEARCH_DAYS = 4;
const EXIT_SEARCH_DAYS = 5;

// Earnings-proximity sub-hypothesis cutoffs.
const NEAR_EARNINGS_MAX_DAYS = 15; // 0..15 days to earnings = "near a catalyst"
const NO_CATALYST_MIN_DAYS = 45; // > 45 days (or unknown) = "no near catalyst"

// Market-cap buckets (USD).
const CAP_BUCKETS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: 'micro (<$300M)', lo: 0, hi: 300e6 },
  { label: 'small ($300M–$2B)', lo: 300e6, hi: 2e9 },
  { label: 'mid ($2B–$10B)', lo: 2e9, hi: 10e9 },
  { label: 'large (>$10B)', lo: 10e9, hi: Infinity },
];

const YF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ──────────────────────────────────────────────────────────────────────────
// Date + numeric helpers (UTC calendar math; immune to DST)
// ──────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ymdUtcMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

function addDaysYmd(s: string, days: number): string {
  const d = new Date(ymdUtcMs(s) + days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function diffDaysYmd(a: string, b: string): number {
  return Math.round((ymdUtcMs(b) - ymdUtcMs(a)) / 86_400_000);
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stddev(xs: readonly number[], m: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

// ──────────────────────────────────────────────────────────────────────────
// Statistics — Spearman, Welch t, Student-t p-values (no external libraries)
// ──────────────────────────────────────────────────────────────────────────

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

function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  return Math.min(1, ibeta(df / 2, 0.5, df / (df + t * t)));
}

function welch(a: readonly number[], b: readonly number[]): { t: number; df: number; p: number } {
  if (a.length < 2 || b.length < 2) return { t: 0, df: 0, p: 1 };
  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = stddev(a, m1) ** 2;
  const v2 = stddev(b, m2) ** 2;
  const se2 = v1 / a.length + v2 / b.length;
  if (se2 <= 0) return { t: 0, df: a.length + b.length - 2, p: 1 };
  const t = (m1 - m2) / Math.sqrt(se2);
  const df =
    (se2 * se2) /
    ((v1 * v1) / (a.length * a.length * (a.length - 1)) + (v2 * v2) / (b.length * b.length * (b.length - 1)));
  return { t, df, p: tTwoSidedP(t, df) };
}

function spearmanP(rho: number, n: number): number {
  if (n < 4) return 1;
  if (Math.abs(rho) >= 1) return 0;
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return tTwoSidedP(t, n - 2);
}

// ──────────────────────────────────────────────────────────────────────────
// Rate-limited fetch with exponential backoff (max 3 retries)
// ──────────────────────────────────────────────────────────────────────────

let lastFetchAt = 0;
const FETCH_GAP_MS = 150;

async function fetchWithRetry(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const wait = lastFetchAt + FETCH_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': YF_UA }, signal: AbortSignal.timeout(15_000) });
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
// Yahoo Finance adjusted closes (adjusted ONLY — never raw)
// ──────────────────────────────────────────────────────────────────────────

interface Series {
  dates: string[]; // sorted YYYY-MM-DD
  px: Map<string, number>;
}

interface YahooChart {
  chart?: {
    result?: Array<{ timestamp?: number[]; indicators?: { adjclose?: Array<{ adjclose?: Array<number | null> }> } }>;
  };
}

const seriesCache = new Map<string, Series | null>();
const skippedTickers = new Set<string>();

async function fetchSeries(symbol: string, fromYmd: string): Promise<Series | null> {
  const cached = seriesCache.get(symbol);
  if (cached !== undefined) return cached;
  const period1 = Math.floor((ymdUtcMs(fromYmd) - 10 * 86_400_000) / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetchWithRetry(url);
  if (!res) {
    seriesCache.set(symbol, null);
    skippedTickers.add(symbol);
    return null;
  }
  let json: YahooChart;
  try {
    json = (await res.json()) as YahooChart;
  } catch {
    seriesCache.set(symbol, null);
    skippedTickers.add(symbol);
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
    seriesCache.set(symbol, null);
    skippedTickers.add(symbol);
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
// DB loading (read-only)
// ──────────────────────────────────────────────────────────────────────────

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteCtor = new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => SqliteDb;

interface TrackRecordRow {
  insider_name: string;
  insider_role: string | null;
  recent_trades: string | null;
  pattern: string | null;
}
interface SignalEarningsRow {
  ticker: string;
  trade_date: string | null;
  days_to_earnings: number | null;
}
interface TickerCapRow {
  ticker: string;
  market_cap: number | null;
}

function safeJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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

interface DbBundle {
  records: TrackRecordRow[];
  earningsByKey: Map<string, number>; // "TICKER|YYYY-MM-DD" → daysToEarnings
  capByTicker: Map<string, number>;
}

function loadDb(): { bundle: DbBundle | null; note: string } {
  const dbPath = findDbPath();
  if (!dbPath) return { bundle: null, note: 'No local signals DB found (set BACKTEST_DB to override).' };

  let Ctor: SqliteCtor;
  try {
    const req = createRequire(__filename);
    Ctor = req('better-sqlite3') as SqliteCtor;
  } catch (err) {
    return {
      bundle: null,
      note:
        'better-sqlite3 failed to load under this runtime (it is built for the Electron ABI). ' +
        'Run `npm run backtest:opportunistic` (which invokes electron). ' +
        `[${err instanceof Error ? err.message.split('\n')[0] : String(err)}]`,
    };
  }

  const db = new Ctor(dbPath, { readonly: true, fileMustExist: true }); // READ-ONLY
  try {
    const records = db
      .prepare(
        `SELECT insider_name, insider_role, recent_trades, pattern
         FROM insider_track_records
         WHERE pattern IN ('routine','opportunistic') AND recent_trades IS NOT NULL`,
      )
      .all() as unknown as TrackRecordRow[];

    const earningsByKey = new Map<string, number>();
    try {
      const rows = db
        .prepare(
          `SELECT ticker, trade_date, days_to_earnings FROM signals
           WHERE trade_date IS NOT NULL AND days_to_earnings IS NOT NULL`,
        )
        .all() as unknown as SignalEarningsRow[];
      for (const r of rows) {
        if (!r.trade_date || r.days_to_earnings == null) continue;
        const key = `${r.ticker.toUpperCase()}|${r.trade_date}`;
        if (!earningsByKey.has(key)) earningsByKey.set(key, r.days_to_earnings);
      }
    } catch {
      /* signals table shape may vary — earnings sub-test just degrades */
    }

    const capByTicker = new Map<string, number>();
    try {
      const rows = db
        .prepare(`SELECT ticker, market_cap FROM ticker_meta WHERE market_cap IS NOT NULL`)
        .all() as unknown as TickerCapRow[];
      for (const r of rows) if (r.market_cap != null) capByTicker.set(r.ticker.toUpperCase(), r.market_cap);
    } catch {
      /* ticker_meta may not exist on old DBs — cap sub-test degrades */
    }

    return { bundle: { records, earningsByKey, capByTicker }, note: `Loaded ${records.length} classified insider record(s) from ${dbPath}.` };
  } finally {
    db.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Observations
// ──────────────────────────────────────────────────────────────────────────

type Pattern = 'routine' | 'opportunistic';

interface Observation {
  insiderKey: string;
  ticker: string;
  date: string; // trade date (YYYY-MM-DD)
  pattern: Pattern;
  roleCategory: string;
  isCSuite: boolean;
  isDirector: boolean;
  marketCap?: number;
  daysToEarnings?: number;
  alpha: Partial<Record<Horizon, number>>;
}

function cleanTicker(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
}

function buildRawObservations(bundle: DbBundle): Observation[] {
  const out: Observation[] = [];
  for (const rec of bundle.records) {
    const pattern = rec.pattern === 'opportunistic' ? 'opportunistic' : 'routine';
    const insiderKey = normalizeInsiderName(rec.insider_name);
    if (!insiderKey) continue;
    const cat = getRankWeight(rec.insider_role ?? '').category;
    const isCSuite = cat === 'exec' || cat === 'cfo' || cat === 'csuite';
    const isDirector = cat === 'director';
    const trades = safeJson<InsiderHistoricalTrade[]>(rec.recent_trades) ?? [];
    for (const t of trades) {
      // Purchases only (recentTrades are already purchases, but guard anyway).
      if (classifyTransaction(t.transactionType).modifier <= 0) continue;
      const ticker = cleanTicker(t.ticker ?? '');
      const date = (t.tradeDate ?? '').slice(0, 10);
      if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      out.push({
        insiderKey,
        ticker,
        date,
        pattern,
        roleCategory: cat,
        isCSuite,
        isDirector,
        marketCap: bundle.capByTicker.get(ticker),
        daysToEarnings: bundle.earningsByKey.get(`${ticker}|${date}`),
        alpha: {},
      });
    }
  }
  return out;
}

/** Dedup: one per (insider, ticker, day), then a >= 5-day same-pair gap. */
function dedup(raw: Observation[]): { kept: Observation[]; rawCount: number; dailyCount: number } {
  const rawCount = raw.length;
  const byKey = new Map<string, Observation>();
  for (const o of raw) {
    const key = `${o.insiderKey}|${o.ticker}|${o.date}`;
    if (!byKey.has(key)) byKey.set(key, o); // exact-day dedup; first wins
  }
  const daily = [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lastKept = new Map<string, string>(); // insider|ticker → last kept date
  const kept: Observation[] = [];
  for (const o of daily) {
    const pairKey = `${o.insiderKey}|${o.ticker}`;
    const last = lastKept.get(pairKey);
    if (last !== undefined && diffDaysYmd(last, o.date) < DEDUP_MIN_GAP_DAYS) continue;
    lastKept.set(pairKey, o.date);
    kept.push(o);
  }
  return { kept, rawCount, dailyCount: daily.length };
}

// ──────────────────────────────────────────────────────────────────────────
// Forward alpha
// ──────────────────────────────────────────────────────────────────────────

async function attachAlpha(observations: Observation[]): Promise<{ withAlpha: Observation[]; skipped: number }> {
  if (observations.length === 0) return { withAlpha: [], skipped: 0 };
  const sorted = [...observations].sort((a, b) => (a.date < b.date ? -1 : 1));
  const earliest = sorted[0].date;
  const spy = await fetchSeries('SPY', earliest);
  if (!spy) throw new Error('SPY adjusted-close history unavailable — cannot compute alpha.');

  const tickers = [...new Set(sorted.map((o) => o.ticker))];
  console.log(`Fetching adjusted closes for ${tickers.length} tickers + SPY…`);
  let done = 0;
  for (const t of tickers) {
    await fetchSeries(t, earliest);
    if (++done % 25 === 0) console.log(`  …${done}/${tickers.length}`);
  }

  const todayYmd = new Date().toISOString().slice(0, 10);
  let skipped = 0;
  const withAlpha: Observation[] = [];
  for (const o of sorted) {
    const series = seriesCache.get(o.ticker);
    if (!series) {
      skipped++;
      continue;
    }
    const entryDate = firstOnOrAfter(series, o.date, ENTRY_SEARCH_DAYS);
    const entryPx = entryDate ? series.px.get(entryDate) : undefined;
    const spyEntry = entryDate ? spy.px.get(entryDate) : undefined;
    if (!entryDate || entryPx === undefined || spyEntry === undefined) {
      skipped++;
      continue;
    }
    let any = false;
    for (const h of HORIZONS) {
      const targetExit = addDaysYmd(entryDate, h);
      if (targetExit > todayYmd) continue; // window not ripe yet
      const exitDate = firstOnOrAfter(series, targetExit, EXIT_SEARCH_DAYS);
      const exitPx = exitDate ? series.px.get(exitDate) : undefined;
      const spyExit = exitDate ? spy.px.get(exitDate) : undefined;
      if (!exitDate || exitPx === undefined || spyExit === undefined) continue;
      o.alpha[h] = (exitPx / entryPx - 1) * 100 - (spyExit / spyEntry - 1) * 100;
      any = true;
    }
    if (any) withAlpha.push(o);
    else skipped++;
  }
  return { withAlpha, skipped };
}

// ──────────────────────────────────────────────────────────────────────────
// Group statistics
// ──────────────────────────────────────────────────────────────────────────

interface GroupStat {
  n: number;
  meanAlpha: number;
  medianAlpha: number;
  winRate: number;
  sharpe: number; // mean / std of alpha
}

function groupStat(alphas: readonly number[]): GroupStat {
  const n = alphas.length;
  if (n === 0) return { n: 0, meanAlpha: 0, medianAlpha: 0, winRate: 0, sharpe: 0 };
  const m = mean(alphas);
  const sd = stddev(alphas, m);
  return {
    n,
    meanAlpha: m,
    medianAlpha: median(alphas),
    winRate: alphas.filter((x) => x > 0).length / n,
    sharpe: sd > 0 ? m / sd : 0,
  };
}

function alphasFor(obs: readonly Observation[], pattern: Pattern, h: Horizon): number[] {
  const out: number[] = [];
  for (const o of obs) if (o.pattern === pattern && o.alpha[h] !== undefined) out.push(o.alpha[h] as number);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : '—');
const fp = (p: number): string => (Number.isFinite(p) ? (p < 0.001 ? '<0.001' : p.toFixed(3)) : '—');
const pctv = (x: number): string => `${x >= 0 ? '+' : ''}${f1(x)}%`;

interface Sections {
  periodStart: string;
  periodEnd: string;
  nObs: number;
  dbNote: string;
  dedupNote: string;
  skipped: number;
  obs: Observation[];
}

function buildReport(s: Sections): string {
  const L: string[] = [];
  const opp = s.obs.filter((o) => o.pattern === 'opportunistic');
  const rout = s.obs.filter((o) => o.pattern === 'routine');

  L.push('# Routine vs Opportunistic Insider Classification — Backtest');
  L.push('');
  L.push(
    `_Period: ${s.periodStart || '—'} → ${s.periodEnd || '—'} · ${s.nObs} observations (${opp.length} opportunistic / ${rout.length} routine) · benchmark: SPY (adjusted closes)_`,
  );
  L.push('');

  L.push('## Hypothesis');
  L.push('');
  L.push(
    'Cohen, Malloy & Pomorski (*Decoding Inside Information*, Journal of Finance 2012) show that insider ' +
      'trades are not homogeneous: insiders who trade on a **predictable calendar schedule** ("routine" traders) ' +
      'earn essentially no abnormal returns, while insiders who **deviate from their established pattern** ' +
      '("opportunistic" traders) earn large, persistent alpha — a long-short routine-vs-opportunistic portfolio ' +
      'produced ~82 bps/month in their sample. This backtest tests whether the app\'s calendar-pattern classifier ' +
      '(`classifyInsiderPattern`) reproduces that separation: do trades tagged **opportunistic** carry ' +
      'significantly more forward alpha vs SPY than trades tagged **routine**, out-of-sample?',
  );
  L.push('');

  // ── Results summary ──
  L.push('## Results Summary');
  L.push('');
  L.push('| Group | n (20d) | 5d α | 10d α | 20d α | 60d α | Win% (20d) | Sharpe (20d) | p (opp−rout, 20d) |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  const primaryWelch = welch(alphasFor(s.obs, 'opportunistic', PRIMARY_H), alphasFor(s.obs, 'routine', PRIMARY_H));
  for (const [label, pattern] of [
    ['Opportunistic', 'opportunistic'],
    ['Routine', 'routine'],
  ] as const) {
    const perH = HORIZONS.map((h) => groupStat(alphasFor(s.obs, pattern, h)));
    const primary = groupStat(alphasFor(s.obs, pattern, PRIMARY_H));
    const pcell = label === 'Opportunistic' ? fp(primaryWelch.p) : '—';
    L.push(
      `| ${label} | ${primary.n} | ${perH.map((g) => pctv(g.meanAlpha)).join(' | ')} | ` +
        `${(primary.winRate * 100).toFixed(0)}% | ${f2(primary.sharpe)} | ${pcell} |`,
    );
  }
  L.push('');
  L.push('Per-horizon detail (mean / median / win% / Sharpe / n, and the opportunistic−routine Welch t-test):');
  L.push('');
  L.push('| Horizon | Opp mean | Opp med | Opp win% | Rout mean | Rout med | Rout win% | Δ mean | t | p |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const h of HORIZONS) {
    const oa = alphasFor(s.obs, 'opportunistic', h);
    const ra = alphasFor(s.obs, 'routine', h);
    const og = groupStat(oa);
    const rg = groupStat(ra);
    const w = welch(oa, ra);
    const enough = og.n >= MIN_OBS_PER_GROUP && rg.n >= MIN_OBS_PER_GROUP;
    const pstr = enough ? fp(w.p) + (w.p >= P_MAX ? ' ⚠' : '') : 'n<20';
    L.push(
      `| ${h}d | ${pctv(og.meanAlpha)} (n=${og.n}) | ${pctv(og.medianAlpha)} | ${(og.winRate * 100).toFixed(0)}% | ` +
        `${pctv(rg.meanAlpha)} (n=${rg.n}) | ${pctv(rg.medianAlpha)} | ${(rg.winRate * 100).toFixed(0)}% | ` +
        `${pctv(og.meanAlpha - rg.meanAlpha)} | ${f2(w.t)} | ${pstr} |`,
    );
  }
  L.push('');
  L.push('⚠ = p ≥ 0.05 (insufficient evidence). "n<20" = below the minimum group size for a conclusion.');
  L.push('');

  // ── Spearman IC ──
  L.push('### Spearman IC — opportunistic indicator vs forward alpha');
  L.push('');
  L.push(
    'The classifier emits a **discrete label**, not a confidence score, so there is nothing continuous to rank. ' +
      'The IC below therefore uses the **binary opportunistic indicator** (1 = opportunistic, 0 = routine) — a ' +
      'rank-biserial correlation between the tag and realized alpha. A positive IC means opportunistic trades ' +
      'rank above routine trades on forward return.',
  );
  L.push('');
  L.push('| Horizon | IC (binary) | p | n |');
  L.push('|---|---|---|---|');
  for (const h of HORIZONS) {
    const rows = s.obs.filter((o) => o.alpha[h] !== undefined);
    const xs = rows.map((o) => (o.pattern === 'opportunistic' ? 1 : 0));
    const ys = rows.map((o) => o.alpha[h] as number);
    const rho = xs.length >= 4 ? spearman(xs, ys) : NaN;
    L.push(`| ${h}d | ${f3(rho)} | ${fp(spearmanP(rho, xs.length))} | ${xs.length} |`);
  }
  L.push('');

  // ── Walk-forward ──
  L.push('## In-Sample vs Out-of-Sample');
  L.push('');
  const chrono = [...s.obs].sort((a, b) => (a.date < b.date ? -1 : 1));
  const split = Math.floor(chrono.length * TRAIN_FRACTION);
  const isSet = chrono.slice(0, split);
  const oosSet = chrono.slice(split);
  const splitDate = chrono[split]?.date ?? '—';
  L.push(`70 / 30 chronological split at ${splitDate} — in-sample n=${isSet.length}, out-of-sample n=${oosSet.length}. Headline horizon: ${PRIMARY_H}d.`);
  L.push('');
  L.push('| Split | Opp n | Opp mean α | Rout n | Rout mean α | Δ mean | t | p |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const [label, set] of [
    ['In-sample', isSet],
    ['Out-of-sample', oosSet],
  ] as const) {
    const oa = alphasFor(set, 'opportunistic', PRIMARY_H);
    const ra = alphasFor(set, 'routine', PRIMARY_H);
    const w = welch(oa, ra);
    const enough = oa.length >= MIN_OOS && ra.length >= MIN_OOS;
    L.push(
      `| ${label} | ${oa.length} | ${oa.length ? pctv(mean(oa)) : '—'} | ${ra.length} | ${ra.length ? pctv(mean(ra)) : '—'} | ` +
        `${oa.length && ra.length ? pctv(mean(oa) - mean(ra)) : '—'} | ${enough ? f2(w.t) : '—'} | ${enough ? fp(w.p) : 'n<' + MIN_OOS} |`,
    );
  }
  L.push('');

  // ── Sub-hypotheses ──
  L.push('## Sub-Hypothesis Results');
  L.push('');
  L.push(`Each cell requires n ≥ ${MIN_SUBCELL}; otherwise it is reported as insufficient and no conclusion is drawn.`);
  L.push('');

  // C-suite vs director (within opportunistic).
  L.push('### 1. Opportunistic C-suite vs opportunistic director (20d α)');
  L.push('');
  {
    const csuite = opp.filter((o) => o.isCSuite && o.alpha[PRIMARY_H] !== undefined).map((o) => o.alpha[PRIMARY_H] as number);
    const dir = opp.filter((o) => o.isDirector && o.alpha[PRIMARY_H] !== undefined).map((o) => o.alpha[PRIMARY_H] as number);
    if (csuite.length >= MIN_SUBCELL && dir.length >= MIN_SUBCELL) {
      const w = welch(csuite, dir);
      L.push(`- C-suite: mean ${pctv(mean(csuite))}, n=${csuite.length}`);
      L.push(`- Director: mean ${pctv(mean(dir))}, n=${dir.length}`);
      L.push(`- Δ = ${pctv(mean(csuite) - mean(dir))}, t=${f2(w.t)}, p=${fp(w.p)}${w.p >= P_MAX ? ' — insufficient evidence' : ''}`);
    } else {
      L.push(`- Insufficient data (C-suite n=${csuite.length}, director n=${dir.length}; need ≥ ${MIN_SUBCELL} each).`);
    }
  }
  L.push('');

  // Earnings proximity (within opportunistic).
  L.push('### 2. Opportunistic near earnings vs opportunistic with no near catalyst (20d α)');
  L.push('');
  {
    const near = opp
      .filter((o) => o.daysToEarnings != null && o.daysToEarnings >= 0 && o.daysToEarnings <= NEAR_EARNINGS_MAX_DAYS && o.alpha[PRIMARY_H] !== undefined)
      .map((o) => o.alpha[PRIMARY_H] as number);
    const noCat = opp
      .filter((o) => (o.daysToEarnings == null || o.daysToEarnings > NO_CATALYST_MIN_DAYS) && o.alpha[PRIMARY_H] !== undefined)
      .map((o) => o.alpha[PRIMARY_H] as number);
    if (near.length >= MIN_SUBCELL && noCat.length >= MIN_SUBCELL) {
      const w = welch(near, noCat);
      L.push(`- Near earnings (≤ ${NEAR_EARNINGS_MAX_DAYS}d): mean ${pctv(mean(near))}, n=${near.length}`);
      L.push(`- No near catalyst: mean ${pctv(mean(noCat))}, n=${noCat.length}`);
      L.push(`- Δ = ${pctv(mean(near) - mean(noCat))}, t=${f2(w.t)}, p=${fp(w.p)}${w.p >= P_MAX ? ' — insufficient evidence' : ''}`);
    } else {
      L.push(
        `- Insufficient data (near-earnings n=${near.length}, no-catalyst n=${noCat.length}; need ≥ ${MIN_SUBCELL} each). ` +
          'Earnings proximity is joined from stored signals by (ticker, trade date) and is sparse for historical track-record trades.',
      );
    }
  }
  L.push('');

  // Market-cap buckets.
  L.push('### 3. Effect across market-cap buckets (20d α, opportunistic − routine)');
  L.push('');
  {
    const capKnown = s.obs.filter((o) => o.marketCap != null && o.alpha[PRIMARY_H] !== undefined).length;
    if (capKnown === 0) {
      L.push('- No market-cap data available for these tickers (ticker_meta empty for the classified names). Skipped.');
    } else {
      L.push('| Bucket | Opp n | Opp mean α | Rout n | Rout mean α | Δ | p |');
      L.push('|---|---|---|---|---|---|---|');
      for (const b of CAP_BUCKETS) {
        const inBucket = (o: Observation) => o.marketCap != null && o.marketCap >= b.lo && o.marketCap < b.hi;
        const oa = opp.filter((o) => inBucket(o) && o.alpha[PRIMARY_H] !== undefined).map((o) => o.alpha[PRIMARY_H] as number);
        const ra = rout.filter((o) => inBucket(o) && o.alpha[PRIMARY_H] !== undefined).map((o) => o.alpha[PRIMARY_H] as number);
        const enough = oa.length >= MIN_SUBCELL && ra.length >= MIN_SUBCELL;
        const w = enough ? welch(oa, ra) : null;
        L.push(
          `| ${b.label} | ${oa.length} | ${oa.length ? pctv(mean(oa)) : '—'} | ${ra.length} | ${ra.length ? pctv(mean(ra)) : '—'} | ` +
            `${enough ? pctv(mean(oa) - mean(ra)) : 'n<' + MIN_SUBCELL} | ${w ? fp(w.p) : '—'} |`,
        );
      }
    }
  }
  L.push('');

  // ── Verdict ──
  L.push('## Verdict');
  L.push('');
  const oppN = alphasFor(s.obs, 'opportunistic', PRIMARY_H).length;
  const routN = alphasFor(s.obs, 'routine', PRIMARY_H).length;
  const oppMean = mean(alphasFor(s.obs, 'opportunistic', PRIMARY_H));
  const routMean = mean(alphasFor(s.obs, 'routine', PRIMARY_H));
  const spread = oppMean - routMean;
  const isOa = alphasFor(isSet, 'opportunistic', PRIMARY_H);
  const isRa = alphasFor(isSet, 'routine', PRIMARY_H);
  const oosOa = alphasFor(oosSet, 'opportunistic', PRIMARY_H);
  const oosRa = alphasFor(oosSet, 'routine', PRIMARY_H);
  const isSpread = isOa.length && isRa.length ? mean(isOa) - mean(isRa) : NaN;
  const oosSpread = oosOa.length && oosRa.length ? mean(oosOa) - mean(oosRa) : NaN;

  let verdict: string;
  let action: string;
  if (oppN < MIN_OBS_PER_GROUP || routN < MIN_OBS_PER_GROUP) {
    verdict =
      `**Insufficient data — no conclusion.** At the ${PRIMARY_H}-day horizon there are ${oppN} opportunistic and ` +
      `${routN} routine observations with realized outcomes (need ≥ ${MIN_OBS_PER_GROUP} each). The classifier only ` +
      'labels an insider once their full OpenInsider history has been fetched (on detail-modal open or scrape ' +
      'pre-warm), and only trades old enough to have ripened contribute here, so the sample builds slowly.';
    action =
      `**Do not change scoring weights yet.** The routine/opportunistic flag remains display-only, as designed. ` +
      'Re-run this backtest in ~4–8 weeks once more insiders have been classified and their trades have ripened ' +
      '(target ≥ 20 per group). If/when validated, promote a pattern multiplier through the shadow-scoring (A/B) ' +
      'framework before it ever touches the live score.';
  } else if (primaryWelch.p < P_MAX && spread > 0 && Number.isFinite(oosSpread) && oosSpread > 0) {
    verdict =
      `**Validated (directional + out-of-sample).** Opportunistic trades beat routine by ${pctv(spread)} of ${PRIMARY_H}-day ` +
      `alpha (Welch p=${fp(primaryWelch.p)}), and the sign holds out-of-sample (IS Δ=${pctv(isSpread)}, OOS Δ=${pctv(oosSpread)}). ` +
      'This reproduces the Cohen–Malloy–Pomorski separation in this dataset.';
    action =
      'Introduce a pattern multiplier in `electron/scoring.ts` — e.g. a `getPatternMultiplier(pattern)` returning ' +
      '≈ **1.15 for opportunistic, 0.85 for routine, 1.0 for unclassified**, applied to the insider leg alongside the ' +
      'existing track-record multiplier. Ship it FIRST as a shadow-config knob (`ScoringConfig`) so live-vs-shadow IC ' +
      'can be compared for one cycle before promotion.';
  } else if (primaryWelch.p < P_MAX && spread < 0) {
    verdict =
      `**Inverted and significant.** Routine trades out-performed opportunistic by ${pctv(-spread)} at ${PRIMARY_H}d ` +
      `(p=${fp(primaryWelch.p)}). This contradicts the hypothesis in this sample — most likely a small-sample / ` +
      'regime artifact rather than a real inversion.';
    action =
      '**Do not add a positive opportunistic weight.** Treat as a warning that the current sample is unstable; ' +
      're-run with more data before drawing any structural conclusion. Keep the flag display-only.';
  } else {
    verdict =
      `**Insufficient evidence.** Opportunistic−routine ${PRIMARY_H}-day spread is ${pctv(spread)} but not significant ` +
      `(Welch p=${fp(primaryWelch.p)} ≥ ${P_MAX})` +
      (Number.isFinite(oosSpread) ? `, and out-of-sample Δ=${pctv(oosSpread)}.` : '.') +
      ' The point estimate ' +
      (spread > 0 ? 'leans in the hypothesized direction' : 'does not favor the hypothesis') +
      ', but the data cannot rule out zero.';
    action =
      '**Do not change scoring weights.** Keep the flag display-only and re-run in ~4–8 weeks with a larger, riper ' +
      'sample. Only promote a pattern multiplier once the ' + PRIMARY_H + 'd spread is positive AND significant AND ' +
      'holds out-of-sample — and then via the shadow-scoring framework first.';
  }
  L.push(verdict);
  L.push('');
  L.push('## Recommended Action');
  L.push('');
  L.push(action);
  L.push('');

  // ── Methodology ──
  L.push('## Methodology & Caveats');
  L.push('');
  L.push(`- ${s.dbNote}`);
  L.push(`- Observations: ${s.dedupNote}. ${s.skipped} dropped for missing/short price windows.`);
  L.push(
    `- ${skippedTickers.size} ticker(s) had no usable Yahoo adjusted series${skippedTickers.size ? `: ${[...skippedTickers].slice(0, 30).join(', ')}${skippedTickers.size > 30 ? ', …' : ''}` : ''}.`,
  );
  L.push('- Forward alpha = stock adjusted-close return − SPY adjusted-close return over the same window. Entry = first trading close on/after the trade date; exit = first trading close on/after entry + horizon.');
  L.push('- Pattern label is at the INSIDER level (`classifyInsiderPattern` over the full purchase history); every ripe recent trade of that insider inherits it. Role (C-suite/director) is likewise the insider-level `insider_role`, bucketed via `getRankWeight`.');
  L.push('- Earnings proximity is a best-effort read-only join from stored `signals` by (ticker, trade date); market cap from `ticker_meta`. Both are sparse for historical trades and drive the "insufficient data" fallbacks above.');
  L.push('- Read-only: this script never writes to the database or modifies any scraper. No data snooping — every test above was defined before the run.');
  L.push('');
  L.push(`_Generated ${new Date().toISOString()} by scripts/backtest-opportunistic.ts._`);
  L.push('');
  return L.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Routine vs Opportunistic backtest — protocol fixed up-front; see header comment.\n');

  const { bundle, note } = loadDb();
  console.log(note);
  if (!bundle) {
    // Still emit a report so the run is self-documenting.
    const report = buildReport({
      periodStart: '',
      periodEnd: '',
      nObs: 0,
      dbNote: note,
      dedupNote: 'no data loaded',
      skipped: 0,
      obs: [],
    });
    fs.writeFileSync(path.resolve(process.cwd(), 'backtest-opportunistic-report.md'), report, 'utf8');
    console.log('\nReport written (no data): backtest-opportunistic-report.md');
    process.exit(0);
  }

  const raw = buildRawObservations(bundle);
  const { kept, rawCount, dailyCount } = dedup(raw);
  const dedupNote = `${rawCount} raw trades → ${dailyCount} per insider-ticker-day → ${kept.length} after the ${DEDUP_MIN_GAP_DAYS}-day same-pair gap`;
  console.log(`Dedup: ${dedupNote}.`);

  let withAlpha: Observation[] = [];
  let skipped = 0;
  if (kept.length > 0) {
    try {
      const res = await attachAlpha(kept);
      withAlpha = res.withAlpha;
      skipped = res.skipped;
    } catch (err) {
      console.error('Alpha computation failed:', err instanceof Error ? err.message : String(err));
    }
  }
  const chrono = [...withAlpha].sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(
    `Outcomes: ${withAlpha.length} observations with ≥1 realized horizon ` +
      `(${withAlpha.filter((o) => o.pattern === 'opportunistic').length} opportunistic / ` +
      `${withAlpha.filter((o) => o.pattern === 'routine').length} routine).`,
  );

  const report = buildReport({
    periodStart: chrono[0]?.date ?? '',
    periodEnd: chrono[chrono.length - 1]?.date ?? '',
    nObs: withAlpha.length,
    dbNote: note,
    dedupNote,
    skipped,
    obs: withAlpha,
  });

  const outPath = path.resolve(process.cwd(), 'backtest-opportunistic-report.md');
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(`\nReport written: ${outPath}`);

  // Console mirror of the headline.
  for (const h of HORIZONS) {
    const og = groupStat(alphasFor(withAlpha, 'opportunistic', h));
    const rg = groupStat(alphasFor(withAlpha, 'routine', h));
    const w = welch(alphasFor(withAlpha, 'opportunistic', h), alphasFor(withAlpha, 'routine', h));
    console.log(
      `  ${h}d  opp ${pctv(og.meanAlpha)} (n=${og.n})  rout ${pctv(rg.meanAlpha)} (n=${rg.n})  ` +
        `Δ ${pctv(og.meanAlpha - rg.meanAlpha)}  p=${fp(w.p)}`,
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error('backtest-opportunistic failed:', err);
  process.exit(1);
});
