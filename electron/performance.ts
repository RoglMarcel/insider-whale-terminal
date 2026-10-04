import type { PerformanceReport, PerformanceTierStats, PerformanceBucketStats } from '../src/types';
import { getSignalRowsForBacktest } from './database';
import { fetchAdjCloseSeries } from './prices';

/**
 * In-app calibration report — replays stored signals against realized forward
 * alpha vs SPY so the user can audit whether conviction tiers actually work.
 * Same statistical protocol as the CLI backtests (F31: one observation per
 * ticker-day, 5-day same-ticker gap, 27-day ripeness so every observation has
 * a complete 20-day outcome; adjusted closes only — F15).
 */

const HORIZONS = [10, 20] as const;
const RIPENESS_DAYS = 27;
const MIN_GAP_DAYS = 5;
const MAX_OBSERVATIONS = 400;
const ENTRY_SEARCH_DAYS = 4;
const EXIT_SEARCH_DAYS = 5;

let recomputeInFlight = false;

// ── date + series helpers (UTC calendar math; adjusted closes only) ──

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

interface Series {
  dates: string[];
  px: Map<string, number>;
}

/** Adjusted-close series in the shape this module indexes by date. */
async function fetchSeries(symbol: string, fromYmd: string): Promise<Series | null> {
  const points = await fetchAdjCloseSeries(symbol, { fromYmd });
  if (!points?.length) return null;
  const px = new Map<string, number>();
  for (const p of points) px.set(p.date, p.px);
  return { dates: [...px.keys()].sort(), px };
}

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
  return diffDaysYmd(target, dates[lo]) <= maxDays ? dates[lo] : null;
}

// ── stats ──

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

function spearman(xs: readonly number[], ys: readonly number[]): number {
  const rx = tieRanks(xs);
  const ry = tieRanks(ys);
  const n = xs.length;
  if (n < 2) return 0;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ── report ──

interface Observation {
  ticker: string;
  date: string;
  score: number;
  tier: string;
  alpha10?: number;
  alpha20?: number;
}

export async function computePerformanceReport(): Promise<PerformanceReport> {
  if (recomputeInFlight) throw new Error('A performance recompute is already running.');
  recomputeInFlight = true;
  try {
    return await computeInner();
  } finally {
    recomputeInFlight = false;
  }
}

async function computeInner(): Promise<PerformanceReport> {
  const nowYmd = new Date().toISOString().slice(0, 10);
  const ripeEnd = addDaysYmd(nowYmd, -RIPENESS_DAYS);

  // F31 protocol: one observation per ticker-day (highest score wins)…
  // Entry = max(trade, filing, first-seen) — never pure trade date (info may
  // not have been public yet).
  const entryYmd = (r: { trade_date: string | null; filing_date?: string | null; scraped_at: string }) => {
    const cands: string[] = [];
    if (r.trade_date && /^\d{4}-\d{2}-\d{2}$/.test(r.trade_date)) cands.push(r.trade_date);
    if (r.filing_date && /^\d{4}-\d{2}-\d{2}$/.test(r.filing_date)) cands.push(r.filing_date);
    const scraped = r.scraped_at.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(scraped)) cands.push(scraped);
    return cands.length ? cands.sort().slice(-1)[0] : scraped;
  };
  const rows = getSignalRowsForBacktest();
  const byTickerDay = new Map<string, Observation>();
  for (const r of rows) {
    const date = entryYmd(r);
    if (date > ripeEnd) continue;
    const key = `${r.ticker}|${date}`;
    // FIRST sighting wins, not the highest score. Rows arrive ordered by
    // scraped_at, and several runs can share one entry date; keeping the max
    // picked the best of N intraday scores after the fact, which is a
    // selection bias in favour of the model being measured.
    // (`label-outcomes.ts` already uses MIN(id) for the same reason.)
    if (!byTickerDay.has(key)) {
      byTickerDay.set(key, { ticker: r.ticker, date, score: r.score, tier: r.conviction_level ?? 'LOW' });
    }
  }
  // …then a minimum gap between observations of the same ticker.
  // Keep the NEWEST MAX_OBSERVATIONS after the full gap filter (not the oldest).
  const daily = [...byTickerDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastKept = new Map<string, string>();
  const allObs: Observation[] = [];
  for (const o of daily) {
    const last = lastKept.get(o.ticker);
    if (last !== undefined && diffDaysYmd(last, o.date) < MIN_GAP_DAYS) continue;
    lastKept.set(o.ticker, o.date);
    allObs.push(o);
  }
  const observations =
    allObs.length > MAX_OBSERVATIONS ? allObs.slice(allObs.length - MAX_OBSERVATIONS) : allObs;

  const empty: PerformanceReport = {
    ranAt: new Date().toISOString(),
    fromDate: observations[0]?.date ?? null,
    toDate: observations[observations.length - 1]?.date ?? null,
    nObservations: 0,
    tiers: [],
    buckets: [],
    ic10: null,
  };
  if (observations.length === 0) {
    return { ...empty, note: `No signals are ${RIPENESS_DAYS}+ days old yet — outcomes need time to ripen. Re-run in a few weeks.` };
  }

  const earliest = observations[0].date;
  const spy = await fetchSeries('SPY', earliest);
  if (!spy) return { ...empty, note: 'SPY price history unavailable — cannot compute alpha right now.' };

  const seriesCache = new Map<string, Series | null>();
  const tickers = [...new Set(observations.map((o) => o.ticker))];
  for (const t of tickers) {
    seriesCache.set(t, await fetchSeries(t, earliest));
    await new Promise((r) => setTimeout(r, 150)); // polite Yahoo pacing
  }

  const scored: Observation[] = [];
  for (const o of observations) {
    const series = seriesCache.get(o.ticker);
    if (!series) continue;
    const entryDate = firstOnOrAfter(series, o.date, ENTRY_SEARCH_DAYS);
    const entryPx = entryDate ? series.px.get(entryDate) : undefined;
    const spyEntry = entryDate ? spy.px.get(entryDate) : undefined;
    if (!entryDate || entryPx === undefined || spyEntry === undefined) continue;
    let ok = true;
    const alphas: Record<number, number> = {};
    for (const h of HORIZONS) {
      const exitDate = firstOnOrAfter(series, addDaysYmd(entryDate, h), EXIT_SEARCH_DAYS);
      const exitPx = exitDate ? series.px.get(exitDate) : undefined;
      const spyExit = exitDate ? spy.px.get(exitDate) : undefined;
      if (!exitDate || exitPx === undefined || spyExit === undefined) {
        ok = false;
        break;
      }
      alphas[h] = (exitPx / entryPx - 1) * 100 - (spyExit / spyEntry - 1) * 100;
    }
    if (!ok) continue;
    scored.push({ ...o, alpha10: alphas[10], alpha20: alphas[20] });
  }

  if (scored.length === 0) {
    return { ...empty, note: 'No observations had usable price windows (delistings / missing adjusted data).' };
  }

  const tiers: PerformanceTierStats[] = [];
  for (const tier of ['HIGH', 'WATCH', 'LOW']) {
    const d = scored.filter((o) => o.tier === tier);
    if (!d.length) continue;
    const a10 = d.map((o) => o.alpha10 as number);
    const a20 = d.map((o) => o.alpha20 as number);
    tiers.push({
      tier,
      n: d.length,
      winRate10: a10.filter((x) => x > 0).length / d.length,
      avgAlpha10: mean(a10),
      avgAlpha20: mean(a20),
    });
  }

  const bucketDefs: Array<[string, (s: number) => boolean]> = [
    ['0–20', (s) => s < 20],
    ['20–40', (s) => s >= 20 && s < 40],
    ['40–60', (s) => s >= 40 && s < 60],
    ['60–80', (s) => s >= 60 && s < 80],
    ['80–100', (s) => s >= 80],
  ];
  const buckets: PerformanceBucketStats[] = [];
  for (const [label, fn] of bucketDefs) {
    const d = scored.filter((o) => fn(o.score));
    if (d.length) buckets.push({ label, n: d.length, avgAlpha10: mean(d.map((o) => o.alpha10 as number)) });
  }

  const ic10 =
    scored.length >= 8
      ? Math.round(spearman(scored.map((o) => o.score), scored.map((o) => o.alpha10 as number)) * 1000) / 1000
      : null;

  return {
    ranAt: new Date().toISOString(),
    fromDate: scored[0].date,
    toDate: scored[scored.length - 1].date,
    nObservations: scored.length,
    tiers,
    buckets,
    ic10,
    note:
      scored.length < 30
        ? `Only ${scored.length} ripened observations — treat these numbers as directional, not statistical.`
        : undefined,
  };
}
