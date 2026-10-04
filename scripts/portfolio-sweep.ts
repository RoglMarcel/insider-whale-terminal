/**
 * Parameter sweep for the testing portfolio (READ-ONLY).
 *
 *   npm run portfolio:sweep
 *
 * Re-runs the whole simulation under alternative thresholds, hold limits,
 * barrier pairs and cash policies, and prints one row per variant.
 *
 * READ THE CAVEAT IT PRINTS. With ~11 entry days of stored signal history and a
 * handful of signals above the threshold, no variant here is statistically
 * distinguishable from any other. The sweep measures SENSITIVITY — how much the
 * answer moves when a knob moves — not superiority. A single trade decides most
 * of these rows, which is exactly why the defaults are only changed when a
 * variant wins CONSISTENTLY across every threshold step, never on one number.
 *
 * The database is opened read-only; prices missing from the cache (the sweep
 * reaches below the live entry threshold, so it needs tickers the sync never
 * fetched) are pulled into MEMORY and never written back.
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  initDatabase,
  closeDatabase,
  getPortfolioConfig,
  getPortfolioHistoryStart,
  getPortfolioOutcomeCandidates,
  getPortfolioSignalCandidates,
  getPriceBook,
} from '../electron/database';
import { PRICE_REQUEST_GAP_MS, fetchAdjCloseSeries, screenSeries, sleep } from '../electron/prices';
import {
  addDaysYmd,
  computeStats,
  earliestEntryDate,
  realizedDailyVol,
  simulatePortfolio,
  toClosedPosition,
} from '../src/lib/portfolio-rules';
import {
  DEFAULT_PORTFOLIO_CONFIG,
  PORTFOLIO_SIGMA_LOOKBACK_DAYS,
  type PortfolioCandidate,
  type PortfolioConfig,
} from '../src/types';

/** Lowest threshold in the sweep — decides how wide the price fetch has to be. */
const SWEEP_MIN_SCORE = 60;
const THRESHOLDS = [60, 65, 70, 74, 78];
/**
 * Extended past 60 days in v1.5.0. The literature measures the insider-purchase
 * drift over six to TWELVE months (docs/portfolio/EXIT-STRATEGY.md), so a sweep
 * that stopped at 60 could not even express the recommendation it was supposed
 * to test. Rows longer than the stored window are not wrong, they are EMPTY —
 * the time stop never binds, so the row silently becomes "hold to the end of the
 * history". That is why every row prints its own `n`.
 */
const HOLD_DAYS = [10, 20, 30, 45, 60, 90, 120, 180];
const BARRIERS: Array<[number | null, number | null]> = [
  [0.15, 0.08],
  [0.2, 0.1],
  [0.25, 0.12],
  [0.3, 0.15],
  [null, 0.25], // no take-profit — the direct test of the right-tail hypothesis
  [0.2, null], // no stop-loss
  [null, null], // trailing + time only
];
/**
 * Extra history fetched BEFORE the simulation window, purely so the 60-day
 * volatility estimate the sigma-scaled variant needs exists on day one. It never
 * enters the trading calendar (see `tradingDays` below), so it cannot move a
 * single entry or exit — it only feeds `realizedDailyVol`.
 */
const SIGMA_WARMUP_DAYS = 150;
/** (stop, target) in horizon sigmas. `null` = that barrier is off. */
const SIGMA_VARIANTS: Array<[number | null, number | null]> = [
  [1.0, null],
  [1.5, null],
  [2.0, null],
  [2.0, 3.0],
  [1.0, 2.0],
];

/**
 * Two-sided 95% t critical values by degrees of freedom. A sample of six trades
 * is nowhere near normal-approximation territory — using 1.96 there would print
 * an interval about 20% too narrow, which is the exact direction that flatters a
 * result nobody should be flattered by.
 */
const T95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
  9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131,
  16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08, 22: 2.074,
  23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045,
};
const tCrit = (df: number): number => (df <= 0 ? NaN : df <= 29 ? T95[df] : df <= 60 ? 2.0 : 1.96);

/** Below this a row is arithmetic, not evidence, and is marked as such. */
const MIN_INTERPRETABLE_N = 10;

interface AlphaStat {
  n: number;
  mean: number | null;
  t: number | null;
  lo: number | null;
  hi: number | null;
}

/** Mean per-trade alpha with its t-statistic and 95% confidence interval. */
function alphaStat(alphas: readonly number[]): AlphaStat {
  const n = alphas.length;
  if (!n) return { n: 0, mean: null, t: null, lo: null, hi: null };
  const mean = alphas.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, t: null, lo: null, hi: null };
  const sd = Math.sqrt(alphas.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1));
  if (!(sd > 0)) return { n, mean, t: null, lo: mean, hi: mean };
  const se = sd / Math.sqrt(n);
  const c = tCrit(n - 1);
  return { n, mean, t: mean / se, lo: mean - c * se, hi: mean + c * se };
}

const pct = (v: number | null | undefined, digits = 2): string =>
  v == null ? '   n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;

interface Row {
  label: string;
  entries: number;
  closed: number;
  finalEquity: number;
  totalReturn: number | null;
  edge: number | null;
  winRate: number | null;
  avgAlpha: number | null;
  alphaN: number;
  alphaT: number | null;
  alphaLo: number | null;
  alphaHi: number | null;
  maxDd: number | null;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function printTable(title: string, rows: Row[]): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 96 - title.length))}`);
  console.log(
    `${pad('variant', 18)}${padL('entries', 8)}${padL('closed', 8)}${padL('return', 9)}${padL('vs SPY', 9)}` +
      `${padL('hit', 6)}${padL('Ø α', 9)}${padL('n', 4)}${padL('t', 7)}${padL('95% CI', 19)}${padL('maxDD', 9)}  flag`,
  );
  for (const r of rows) {
    const ci = r.alphaLo == null || r.alphaHi == null ? 'n/a' : `${pct(r.alphaLo, 1)} … ${pct(r.alphaHi, 1)}`;
    console.log(
      pad(r.label, 18) +
        padL(String(r.entries), 8) +
        padL(String(r.closed), 8) +
        padL(pct(r.totalReturn), 9) +
        padL(pct(r.edge), 9) +
        padL(r.winRate == null ? 'n/a' : `${(r.winRate * 100).toFixed(0)}%`, 6) +
        padL(pct(r.avgAlpha), 9) +
        padL(String(r.alphaN), 4) +
        padL(r.alphaT == null ? 'n/a' : r.alphaT.toFixed(2), 7) +
        padL(ci, 19) +
        padL(pct(r.maxDd), 9) +
        (r.alphaN < MIN_INTERPRETABLE_N ? `  n<${MIN_INTERPRETABLE_N} — UNINTERPRETABLE` : ''),
    );
  }
}

async function main(): Promise<void> {
  const dbPath = (process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'insider-tracker.db')).trim();
  if (!fs.existsSync(dbPath)) {
    console.log(`No database at ${dbPath}.`);
    return;
  }
  console.log(`DB: ${dbPath} (read-only)\n`);
  initDatabase(dbPath, { readonly: true });

  const base: PortfolioConfig = { ...DEFAULT_PORTFOLIO_CONFIG, ...getPortfolioConfig() };

  // Candidates at the WIDEST threshold; each variant filters further.
  const candidates: PortfolioCandidate[] = [
    ...getPortfolioSignalCandidates(SWEEP_MIN_SCORE).map((r) => ({
      ticker: r.ticker,
      earliestDate: earliestEntryDate(r.seenAt),
      score: r.score,
      signalId: r.signalId,
      source: 'signal' as const,
    })),
    ...getPortfolioOutcomeCandidates(SWEEP_MIN_SCORE).map((r) => ({
      ticker: r.ticker,
      earliestDate: addDaysYmd(r.seenAt.slice(0, 10), 1),
      score: r.score,
      signalId: null,
      source: 'outcome' as const,
    })),
  ];
  const universe = [...new Set(candidates.map((c) => c.ticker))].sort();
  // Same origin the live sync uses, so "vs SPY" here means the same thing it
  // means on the Portfolio tab rather than being measured over a shifted window.
  const start =
    getPortfolioHistoryStart(SWEEP_MIN_SCORE) ??
    candidates.reduce((m, c) => (c.earliestDate < m ? c.earliestDate : m), '9999-12-31');

  // Cache first, network only for what is genuinely missing. Nothing is written.
  // Prices reach back BEFORE the window so the 60-day volatility estimate exists
  // on the first entry day; the trading calendar is clipped back to `start`
  // below, so the warm-up cannot move a single fill.
  const priceStart = addDaysYmd(start, -SIGMA_WARMUP_DAYS);
  const prices: Record<string, Record<string, number>> = getPriceBook([...universe, 'SPY'], priceStart);
  const toFetch = [...universe, 'SPY'].filter((t) => !prices[t] || !Object.keys(prices[t]).length);
  if (toFetch.length) {
    console.log(`Fetching ${toFetch.length} series the cache does not have (in memory only)…`);
    for (const t of toFetch) {
      await sleep(PRICE_REQUEST_GAP_MS);
      const points = await fetchAdjCloseSeries(t, { fromYmd: priceStart });
      if (!points?.length) continue;
      prices[t] = Object.fromEntries(screenSeries(points).clean.map((p) => [p.date, p.px]));
    }
  }

  const spy = prices.SPY;
  if (!spy || !Object.keys(spy).length) {
    console.log('SPY series unavailable — a sweep without the benchmark says nothing.');
    closeDatabase();
    return;
  }
  // THE window. Anything earlier is volatility warm-up only.
  const tradingDays = Object.keys(spy)
    .filter((d) => d >= start)
    .sort();
  // How many tickers can actually produce a sigma on their first tradable day —
  // a sigma-scaled row where this is low is measuring the FIXED fallback.
  const sigmaReady = universe.filter((t) => realizedDailyVol(prices[t], tradingDays[0]) != null).length;

  const run = (label: string, over: Partial<PortfolioConfig>): Row => {
    const config: PortfolioConfig = { ...base, ...over };
    const sim = simulatePortfolio({ config, tradingDays, spy, prices, candidates });
    const closed = sim.positions.filter((p) => p.exitDate).map(toClosedPosition);
    const stats = computeStats(sim.equity, closed, [], config);
    const max = stats.windows.find((w) => w.key === 'max');
    const last = sim.equity[sim.equity.length - 1];
    const a = alphaStat(closed.map((c) => c.tradeAlpha).filter((x): x is number => x != null));
    return {
      label,
      entries: sim.positions.length,
      closed: closed.length,
      finalEquity: last?.equity ?? config.startingCash,
      totalReturn: max?.portfolio ?? null,
      edge: max?.diff ?? null,
      winRate: stats.trades.winRate,
      avgAlpha: a.mean,
      alphaN: a.n,
      alphaT: a.t,
      alphaLo: a.lo,
      alphaHi: a.hi,
      maxDd: stats.maxDrawdown.portfolio,
    };
  };

  /** Label for a (take-profit, stop-loss) pair where either may be off. */
  const barrierLabel = (tp: number | null, sl: number | null): string =>
    `${tp == null ? 'no TP' : `+${(tp * 100).toFixed(0)}%`} / ${sl == null ? 'no SL' : `−${(sl * 100).toFixed(0)}%`}`;

  console.log(
    `Window: ${tradingDays[0]} → ${tradingDays[tradingDays.length - 1]} (${tradingDays.length} sessions) · ` +
      `${candidates.length} candidate sighting(s) at score ≥ ${SWEEP_MIN_SCORE} · ${universe.length} ticker(s)\n` +
      `Volatility warm-up: prices from ${priceStart} · ${sigmaReady}/${universe.length} ticker(s) can produce a ` +
      `${PORTFOLIO_SIGMA_LOOKBACK_DAYS}d sigma on day one (the rest fall back to the fixed percentages)`,
  );
  const benchRow = run('SPY buy & hold', { entryScore: 1e9 });
  console.log(`Benchmark over the same window: ${pct(benchRow.totalReturn)}\n`);

  printTable(
    'Entry threshold (everything else at the defaults)',
    THRESHOLDS.map((t) => run(`score ≥ ${t}`, { entryScore: t })),
  );
  printTable(
    'Time stop (calendar days)',
    HOLD_DAYS.map((d) => run(`hold ≤ ${d}d`, { maxHoldDays: d })),
  );
  printTable(
    'Take-profit / stop-loss (fixed %) — "no TP" is the right-tail test',
    BARRIERS.map(([tp, sl]) => run(barrierLabel(tp, sl), { takeProfit: tp, stopLoss: sl })),
  );
  printTable(
    `Volatility-scaled barriers (sigma = ${PORTFOLIO_SIGMA_LOOKBACK_DAYS}d realised daily vol × √(trading days in the time stop))`,
    [
      run('fixed % (default)', {}),
      ...SIGMA_VARIANTS.map(([stop, target]) =>
        run(`${stop == null ? 'no SL' : `${stop}σ SL`} / ${target == null ? 'no TP' : `${target}σ TP`}`, {
          sigmaBarriers: { stop, target, trailArm: null, trailDistance: null },
        }),
      ),
    ],
  );
  printTable('Cash policy', [
    run('cash → SPY', { cashPolicy: 'spy' }),
    run('cash idle', { cashPolicy: 'idle' }),
  ]);

  // Cross-check: does one time stop win at EVERY threshold, or only on average?
  console.log(`\n── Time stop × entry threshold (avg trade alpha) ${'─'.repeat(30)}`);
  console.log(pad('', 12) + HOLD_DAYS.map((d) => padL(`${d}d`, 11)).join(''));
  for (const t of THRESHOLDS) {
    const cells = HOLD_DAYS.map((d) => {
      const r = run('x', { entryScore: t, maxHoldDays: d });
      return padL(`${pct(r.avgAlpha, 1)}/${r.alphaN}`, 11);
    });
    console.log(pad(`≥ ${t}`, 12) + cells.join(''));
  }

  console.log(`
── How much of this is real? ───────────────────────────────────────────────
The stored signal history is ~6 weeks and produces a single-digit number of
entries at the default threshold. Every row above therefore rests on a handful
of trades, several of them the same ticker, and one position can move a whole
column by percentage points.

Read these as SENSITIVITY, not as a ranking: they show how hard the result
leans on each knob, which is worth knowing. They cannot show that one setting
is better than another — there is not enough data for that question to have an
answer yet, and picking the best-looking row would be fitting to noise.

The defaults change only when a variant wins across EVERY threshold step in the
cross-table above, not when it wins on average. The v1.5.0 exit rules were NOT
chosen here — they come from the published literature (docs/portfolio/
EXIT-STRATEGY.md). This sweep exists to test them later, not to have picked them.

TWO TRAPS SPECIFIC TO THE LONG ROWS
  1. A time stop longer than the stored window never BINDS. Rows at 90 / 120 /
     180 days are not "a 90-day hold measured" — they are "hold until some other
     barrier or the end of the data", and they are identical to each other for
     exactly that reason. Watch the "closed" column: when it stops falling, the
     time stop has stopped doing anything and the row is a duplicate.
  2. A sigma-scaled row silently degrades to the fixed percentages for any
     ticker without enough price history to estimate sigma (see the sigma-ready
     count printed above the tables). A low count means that table is comparing
     "fixed" against "mostly fixed".`);

  closeDatabase();
}

main().catch((err) => {
  console.error('[sweep] THREW:', err);
  process.exit(1);
});
