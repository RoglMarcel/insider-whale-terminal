import { tickerIssue, resolvedTicker } from '../src/lib/ticker-quality';
import { yahooTicker } from './scraper/util';
import { priceTicker, type PriceIdentity } from './priceSymbols';

/**
 * The one place adjusted closes enter this codebase.
 *
 * `performance.ts`, `scripts/label-outcomes.ts` and the testing portfolio all
 * used to carry their own copy of "fetch Yahoo, read indicators.adjclose, map
 * timestamps to YYYY-MM-DD" — three copies of the same three subtle rules
 * (dash-form symbols, adjusted closes only, drop non-finite points), which is
 * exactly the kind of duplication that lets one of them quietly diverge.
 *
 * Adjusted closes ONLY. A raw close series turns a 2:1 split into a −50% day,
 * which every stop-loss in the portfolio would dutifully act on.
 */

const YF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** Polite pacing between requests — Yahoo throttles bursts, not volume. */
export const PRICE_REQUEST_GAP_MS = 120;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A single-session move larger than this is treated as a data error, not a
 * market event. Real equities do move 60% in a day (biotech readouts, halts),
 * so this is deliberately loose: it is a guard against Yahoo returning a stale
 * or mis-scaled point, not a volatility filter.
 */
export const PRICE_MAX_DAILY_MOVE = 0.6;

export interface PricePoint {
  date: string;
  px: number;
}

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { adjclose?: Array<{ adjclose?: Array<number | null> }> };
    }>;
  };
}

export interface FetchSeriesOptions {
  /** Start of the window; 10 days of lead-in are added so gap-search works. */
  fromYmd?: string;
  /** Yahoo range shorthand (`1y`, `2y`, `max`). Ignored when `fromYmd` is set. */
  range?: string;
  signal?: AbortSignal;
  identity?: PriceIdentity;
}

function ymdUtcMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

/**
 * Adjusted daily closes for one symbol, ascending, or null when the symbol has
 * no usable series (delisted, renamed, or simply never existed).
 */
export async function fetchAdjCloseSeries(
  symbol: string,
  opts: FetchSeriesOptions = {},
): Promise<PricePoint[] | null> {
  if (tickerIssue(symbol)) return null;
  try {
    // Yahoo writes share classes with a DASH (BRK-B) while the pipeline stores
    // the canonical dot form. Without this every class share resolves to 404 and
    // vanishes from the portfolio without a trace.
    const today = new Date().toISOString().slice(0, 10);
    const sym = encodeURIComponent(yahooTicker(priceTicker(resolvedTicker(symbol, today), today, opts.identity)) || symbol);
    let window: string;
    if (opts.fromYmd) {
      const period1 = Math.floor((ymdUtcMs(opts.fromYmd) - 10 * 86_400_000) / 1000);
      const period2 = Math.floor(Date.now() / 1000) + 86_400;
      window = `period1=${period1}&period2=${period2}`;
    } else {
      window = `range=${opts.range ?? '1y'}`;
    }
    let json: YahooChart | null = null;
    let failure = 'no adjusted closes';
    // One retry via Yahoo's other chart host. Never substitute unadjusted
    // quotes: split-adjustment differences can trigger fictitious exits.
    for (const host of ['query1', 'query2']) {
      if (opts.signal?.aborted) return null;
      if (host === 'query2') await sleep(400);
      try {
        const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&${window}`, {
          headers: { 'User-Agent': YF_UA },
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          failure = `HTTP ${res.status}`;
          if (res.status === 404) break;
          continue;
        }
        const candidate = (await res.json()) as YahooChart;
        if (!candidate.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose?.some((p) => p != null && Number.isFinite(p) && p > 0)) {
          failure = 'no adjusted closes';
          continue;
        }
        json = candidate;
        break;
      } catch {
        failure = 'network error or timeout';
      }
    }
    if (!json) {
      console.warn(`[prices] ${symbol}: ${failure} after bounded chart lookup`);
      return null;
    }
    const result = json.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const adj = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const seen = new Set<string>();
    const out: PricePoint[] = [];
    ts.forEach((t, i) => {
      const v = adj[i];
      if (v == null || !Number.isFinite(v) || v <= 0 || !Number.isFinite(t)) return;
      const date = new Date(t * 1000).toISOString().slice(0, 10);
      if (seen.has(date)) return;
      seen.add(date);
      out.push({ date, px: v });
    });
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Outcome dates cannot be due beyond the benchmark's available sessions. */
export function outcomeCutoff(points: readonly PricePoint[], today: string): string | null {
  return points.filter((p) => p.date <= today && p.px > 0 && Number.isFinite(p.px))
    .map((p) => p.date).sort().at(-1) ?? null;
}

export interface ScreenedSeries {
  clean: PricePoint[];
  /** Points rejected by the plausibility check, with the move that failed. */
  suspect: Array<PricePoint & { movePct: number }>;
}

/**
 * Plausibility screen. A single mis-scaled Yahoo point would otherwise fire a
 * stop-loss on a position that never moved, and the trade would be permanently
 * baked into an append-only curve — so a suspect point is DROPPED, not used.
 * The gap it leaves behind is handled by the same next-trading-day search that
 * handles holidays.
 */
export function screenSeries(points: readonly PricePoint[], maxMove = PRICE_MAX_DAILY_MOVE): ScreenedSeries {
  const clean: PricePoint[] = [];
  const suspect: Array<PricePoint & { movePct: number }> = [];
  let prev: number | null = null;
  for (const p of points) {
    if (!Number.isFinite(p.px) || p.px <= 0) {
      suspect.push({ ...p, movePct: NaN });
      continue;
    }
    if (prev != null) {
      const move = p.px / prev - 1;
      if (Math.abs(move) > maxMove) {
        suspect.push({ ...p, movePct: move });
        continue;
      }
    }
    clean.push(p);
    prev = p.px;
  }
  return { clean, suspect };
}

/** First point on or after `date` — the "next trading day" rule, on a series. */
export function priceOnOrAfter(series: readonly PricePoint[], date: string): PricePoint | null {
  for (const p of series) if (p.date >= date) return p;
  return null;
}

/** Compare outcomes on the same observed market session. Missing equity prices
 * must not silently shift one side of an alpha calculation by weeks. */
export function outcomePricePair(series: readonly PricePoint[], benchmark: readonly PricePoint[], date: string): { equity: PricePoint; benchmark: PricePoint } | null {
  const session = priceOnOrAfter(benchmark, date);
  if (!session) return null;
  const equity = series.find(p => p.date === session.date);
  return equity ? { equity, benchmark: session } : null;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
