import { cleanPortfolioCandidates } from '../src/lib/ticker-quality';
import { buildInsiderOnly, INSIDER_ONLY_ID } from '../src/lib/insider-only';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import {
  type PortfolioCandidate,
  type PortfolioClosedPosition,
  type PortfolioConfig,
  type PortfolioEvent,
  type PortfolioOpenPosition,
  type PortfolioState,
} from '../src/types';
import {
  addDaysYmd,
  computeStats,
  earliestEntryDate,
  simulatePortfolio,
  toClosedPosition,
  toOpenPosition,
} from '../src/lib/portfolio-rules';
import {
  clearPortfolio,
  archivePortfolioRevision,
  getPortfolioExperiment,
  setPortfolioExperiment,
  archiveExperimentCandidates,
  clearPortfolioEquity,
  deletePortfolioEquityDay,
  getPortfolioConfig,
  getPortfolioEquity,
  getPortfolioEvents,
  getPortfolioHistoryStart,
  getPortfolioLiveStart,
  getPortfolioOutcomeCandidates,
  getPortfolioPositions,
  getPortfolioRunMeta,
  getPortfolioSignalCandidates,
  getPriceAsOf,
  getPriceBook,
  getPriceCoverage,
  insertPortfolioEquity,
  insertPortfolioSuspectEvents,
  replacePortfolioEvents,
  replacePortfolioPositions,
  setPortfolioConfig,
  setPortfolioRunMeta,
  upsertPriceRows,
  type PriceRow,
} from './database';
import { PRICE_REQUEST_GAP_MS, fetchAdjCloseSeries, screenSeries, sleep } from './prices';

/**
 * Testing portfolio — I/O side (v1.4.0).
 *
 * The RULES live in `src/lib/portfolio-rules.ts` and are pure; this module only
 * feeds them: pull candidate signals out of SQLite, make sure the adjusted-close
 * cache covers the window, run the simulation, persist the result.
 *
 * Two invariants are enforced here rather than in the rules:
 *  - SETTLED days are APPEND-ONLY. A settled day that has been written is never
 *    rewritten, so a later price restatement cannot retroactively move a point
 *    somebody has already looked at. Drift is counted and reported, not silently
 *    applied. Two things are deliberately NOT covered by that rule, because
 *    applying it to them produced a curve that contradicted itself (see the
 *    comment in `runSync`): the newest day, which is provisional intraday data,
 *    and the whole curve when the config changes, which makes the stored rows a
 *    different strategy rather than older history of this one.
 *  - SPY is mandatory. A curve without its benchmark is worthless, so a run that
 *    cannot resolve SPY writes nothing at all.
 */

const BENCHMARK = 'SPY';

/** UTC, to match every other date in this module — all of them are YYYY-MM-DD. */
const todayYmd = (): string => new Date().toISOString().slice(0, 10);

/**
 * Bump when a fix changes how the curve is BUILT, not what it is built from.
 * A stored curve carrying a different version is rebuilt once, on the next sync.
 *
 * A config comparison alone cannot do this job. The splice that motivated all of
 * this was already baked into the stored rows by the time it was found, and by
 * then the config matched again — the damaging change had happened days
 * earlier. Without this counter the repair would wait for the next unrelated
 * config edit to arrive by luck.
 *
 * 2 (2026-08-31): rebuild curves written by the append-only builder, which
 * spliced the v1.4.0 and v1.5.0 exit rules into a single line.
 */
// 3: repair synthetic exits caused by missing quotes; no trade without a price.
// 4: enforce the funded weight floor; replay affected entries and equity together.
// 5: verified ticker identity repair; retain the previous book in portfolio_revisions.
const CURVE_BUILDER_VERSION = 5;

let runInFlight = false;

export interface PortfolioSyncReport {
  ok: boolean;
  reason?: string;
  daysWritten: number;
  restatedDays: number;
  /** The config changed, so the curve was discarded and re-simulated. */
  rebuilt: boolean;
  pricesFetched: number;
  suspectPoints: number;
  missingPriceTickers?: string[];
}

/**
 * Key-order-independent equality for the config blob, which is flat and
 * primitive-valued. Compared rather than version-stamped on purpose: a stamp
 * only catches the changes someone remembered to bump, and the splice this
 * guards against came from a rule change, not a release.
 */
function sameConfig(a: PortfolioConfig, b: PortfolioConfig): boolean {
  const norm = (c: PortfolioConfig) =>
    JSON.stringify(Object.entries(c).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

// ── Candidates ────────────────────────────────────────────────────────────

/**
 * Every signal that ever crossed the threshold, with the earliest date its
 * close could legitimately have been traded.
 *
 * Two sources, deliberately:
 *  - `signals` is precise (it carries the sighting TIMESTAMP) but its rows
 *    rotate, so it currently reaches back only ~9 days.
 *  - `signal_outcomes` reaches five weeks further. Those rows are real signals
 *    that were scored at the time and never recomputed, so they are legitimate
 *    history — but they store only a DATE. Since roughly one scrape in three
 *    runs after the close, the sighting could have been post-close, and the only
 *    assumption that cannot manufacture look-ahead is that it was: their entry
 *    is pushed to the NEXT calendar day. That costs a day of return on the
 *    backfill and biases the result DOWN, which is the right direction for an
 *    instrument whose job is to be believed.
 */
export function buildCandidates(config: PortfolioConfig): PortfolioCandidate[] {
  const out: PortfolioCandidate[] = [];
  for (const r of getPortfolioSignalCandidates(config.entryScore)) {
    out.push({
      ticker: r.ticker,
      earliestDate: earliestEntryDate(r.seenAt),
      score: r.score,
      signalId: r.signalId,
      source: 'signal',
    });
  }
  for (const r of getPortfolioOutcomeCandidates(config.entryScore)) {
    out.push({
      ticker: r.ticker,
      earliestDate: addDaysYmd(r.seenAt.slice(0, 10), 1),
      score: r.score,
      signalId: null,
      source: 'outcome',
    });
  }
  return cleanPortfolioCandidates(out).sort((a, b) => a.earliestDate.localeCompare(b.earliestDate) || b.score - a.score);
}

// ── Prices ────────────────────────────────────────────────────────────────

interface PriceSyncResult {
  fetched: number;
  suspect: PortfolioEvent[];
  missing: string[];
}

/**
 * Top the adjusted-close cache up.
 *
 * At most ONE request per ticker per calendar day: a delisted symbol never
 * catches up to SPY's newest date, so "refetch until current" would re-hammer
 * the same 404 on every run forever.
 */
export async function syncPrices(tickers: readonly string[], fromYmd: string): Promise<PriceSyncResult> {
  const coverage = getPriceCoverage();
  const today = new Date().toISOString().slice(0, 10);
  let spyLast = coverage[BENCHMARK]?.last ?? '';
  // Benchmark first: other tickers must catch up to the NEW benchmark date.
  const ordered = [BENCHMARK, ...tickers.filter((t) => t !== BENCHMARK)];
  const suspect: PortfolioEvent[] = [];
  const missing: string[] = [];
  let fetched = 0;

  for (const ticker of ordered) {
    const cov = coverage[ticker];
    const triedToday = cov?.fetchedAt?.slice(0, 10) === today;
    const current = ticker === BENCHMARK ? false : !!cov && !!spyLast && cov.last >= spyLast;
    if (cov && (triedToday || current)) continue;

    if (fetched > 0) await sleep(PRICE_REQUEST_GAP_MS);
    const points = await fetchAdjCloseSeries(ticker, { fromYmd });
    fetched++;
    if (!points?.length) {
      missing.push(ticker);
      continue;
    }
    const screened = screenSeries(points);
    for (const s of screened.suspect) {
      suspect.push({
        date: s.date,
        kind: 'suspect_price',
        ticker,
        score: null,
        amount: s.px,
        note: Number.isFinite(s.movePct)
          ? `${(s.movePct * 100).toFixed(1)}% single-session move — ignored`
          : 'non-finite adjusted close — ignored',
      });
    }
    const rows: PriceRow[] = screened.clean.map((p) => ({ ticker, date: p.date, adjClose: p.px }));
    upsertPriceRows(rows);
    if (ticker === BENCHMARK && rows.length) {
      spyLast = rows.reduce((latest, row) => row.date > latest ? row.date : latest, spyLast);
    }
  }

  return { fetched, suspect, missing };
}

// ── Run ───────────────────────────────────────────────────────────────────

export async function syncPortfolio(): Promise<PortfolioSyncReport> {
  if (runInFlight) return { ok: false, reason: 'already running', daysWritten: 0, restatedDays: 0, rebuilt: false, pricesFetched: 0, suspectPoints: 0 };
  runInFlight = true;
  try {
    return await runSync();
  } finally {
    runInFlight = false;
  }
}

async function runSync(): Promise<PortfolioSyncReport> {
  const config = getPortfolioConfig();
  const priorMeta = getPortfolioRunMeta();
  if (priorMeta && (priorMeta.curveVersion ?? 1) < 5) archivePortfolioRevision('ticker-cleanup-v1', getPortfolioState());
  const previousExperiment = getPortfolioExperiment(INSIDER_ONLY_ID);
  const firstSignal = getPortfolioHistoryStart(config.entryScore) ?? previousExperiment?.state.meta.firstDate;
  if (!firstSignal) {
    return { ok: false, reason: 'no signal has ever reached the entry threshold', daysWritten: 0, restatedDays: 0, rebuilt: false, pricesFetched: 0, suspectPoints: 0 };
  }
  // Never fetch or simulate before the book opens. The engine enforces this
  // too, but doing it here is what keeps the price sync from pulling months of
  // closes the curve will immediately throw away.
  const start = config.inceptionDate && config.inceptionDate > firstSignal ? config.inceptionDate : firstSignal;

  // Opening day has not arrived. There is no book yet, so the stored one is
  // emptied rather than left alone: a reset whose inception is still in the
  // future would otherwise keep serving the PREVIOUS book's curve — the exact
  // "chart no strategy ever followed" this module already guards against, just
  // arriving through a different door. Writing meta keeps the stored parameters
  // matching the active config, which `verify:portfolio` asserts.
  if (config.inceptionDate && config.inceptionDate > todayYmd()) {
    clearPortfolio();
    setPortfolioRunMeta({
      config,
      curveVersion: CURVE_BUILDER_VERSION,
      builtAt: new Date().toISOString(),
      backfillStart: null,
      liveStart: getPortfolioLiveStart(),
      skippedNoCash: 0,
      skippedCap: 0,
      missingPrices: 0,
      suspectPrices: 0,
      untradableTickers: [],
      restatedDays: 0,
    });
    return {
      ok: false,
      reason: `the book opens on ${config.inceptionDate} — nothing to simulate yet`,
      daysWritten: 0,
      restatedDays: 0,
      rebuilt: false,
      pricesFetched: 0,
      suspectPoints: 0,
    };
  }

  // Candidates first, so the price sync only covers what the book can actually
  // buy. `getPortfolioUniverse` answers "every ticker that ever cleared the
  // threshold", which after the reset is mostly signals from before inception —
  // dozens of series fetched from Yahoo on every run for tickers the engine is
  // about to discard. Narrowing an existing list can only ever remove work.
  const candidates = buildCandidates(config).filter(
    (c) => !config.inceptionDate || c.earliestDate >= config.inceptionDate,
  );
  // Derived FROM the candidates, not intersected with the old worklist: an
  // intersection can only lose a ticker, and a candidate without prices comes
  // back as a false "not tradable" in the data-quality line.
  const experimentCandidates = cleanPortfolioCandidates(archiveExperimentCandidates(INSIDER_ONLY_ID, candidates));
  const universe = [...new Set([...candidates, ...experimentCandidates].map((c) => c.ticker))].sort();
  // Preserve the experiment's calendar even after rolling source rows expire.
  const archivedStart = previousExperiment?.state.meta.firstDate ?? start;
  const experimentStart = config.inceptionDate && config.inceptionDate > archivedStart ? config.inceptionDate : archivedStart;
  const fetchStart = experimentStart < start ? experimentStart : start;
  const priceSync = await syncPrices([BENCHMARK, ...universe.filter((t) => t !== BENCHMARK)], fetchStart);

  const spy = getPriceBook([BENCHMARK], fetchStart)[BENCHMARK];
  if (!spy || !Object.keys(spy).length) {
    // A curve with no benchmark cannot answer the only question it exists for.
    return { ok: false, reason: 'SPY price series unavailable — nothing written', daysWritten: 0, restatedDays: 0, rebuilt: false, pricesFetched: priceSync.fetched, suspectPoints: priceSync.suspect.length };
  }

  const prices = getPriceBook(universe, fetchStart);
  const allTradingDays = Object.keys(spy).sort();
  const tradingDays = allTradingDays.filter((d) => d >= start);

  const sim = simulatePortfolio({ config, tradingDays, spy, prices, candidates });
  const experiment = buildInsiderOnly({ config, tradingDays: allTradingDays.filter((d) => d >= experimentStart), spy, prices, candidates: experimentCandidates }, new Date().toISOString());
  const previousPoints = new Map(previousExperiment?.state.equity.map((p) => [p.date, p.equity]) ?? []);
  experiment.state.meta.restatedDays = experiment.state.equity.filter((p) => previousPoints.has(p.date) && Math.abs(previousPoints.get(p.date)! - p.equity) > 0.01).length;
  experiment.state.meta.suspectPrices = priceSync.suspect.length;

  // A stored curve belongs to the config that built it. Append new rules onto
  // rows simulated under old ones and the chart becomes a splice of two
  // strategies — a line no strategy ever followed.
  //
  // Measured on the live site 2026-08-31, and the reason this exists: the
  // v1.5.0 exit rules (no take-profit, −25% stop, 90 days) were appended to a
  // curve built under v1.4.0's. Four July positions the old rules had closed
  // reappeared on 2026-08-24 with weeks of accumulated gain booked into that
  // single day — the book went from 1 open position to 7 with no buy or sell
  // recorded, +2.90pp against SPY in one day. That artifact was 7.4× the entire
  // +0.39% lead the page was reporting; chain it out and the same curve TRAILS
  // SPY by 2.49pp. The equity rows also stopped matching the position table
  // they are displayed beside ($3,802.66 vs $4,122.89), because positions are
  // REPLACEd from the fresh simulation while the rows were not.
  const storedMeta = getPortfolioRunMeta();
  const staleBuilder = !!storedMeta && (storedMeta.curveVersion ?? 1) !== CURVE_BUILDER_VERSION;
  const configChanged = !!storedMeta && !sameConfig(storedMeta.config, config);
  const rebuilt = staleBuilder || configChanged;
  if (rebuilt) {
    const why = staleBuilder ? `built by curve builder v${storedMeta?.curveVersion ?? 1}` : 'config changed';
    console.log(`[portfolio] stored curve ${why} — rebuilding it from scratch`);
    clearPortfolioEquity();
  }

  // The newest day is provisional: it is marked from intraday prices, so every
  // later run of the same day has to be allowed to correct it. Freezing it is
  // what left the last row disagreeing with its own position table. Only
  // SETTLED days stay append-only — that is what keeps a Yahoo price
  // restatement reported rather than silently applied.
  const provisional = sim.equity[sim.equity.length - 1]?.date;
  if (!rebuilt && provisional) deletePortfolioEquityDay(provisional);

  // Whatever survived the two steps above is real history. Compare it against
  // the fresh simulation so a restatement on a settled day is still REPORTED.
  const stored = new Map(getPortfolioEquity().map((p) => [p.date, p]));
  let restatedDays = 0;
  for (const p of sim.equity) {
    const old = stored.get(p.date);
    if (old && Math.abs(old.equity - p.equity) > 0.01) restatedDays++;
  }
  const daysWritten = insertPortfolioEquity(sim.equity);

  replacePortfolioPositions(sim.positions);
  replacePortfolioEvents(sim.events);
  insertPortfolioSuspectEvents(priceSync.suspect);

  const counts = countEvents(sim.events);
  setPortfolioRunMeta({
    config,
    curveVersion: CURVE_BUILDER_VERSION,
    builtAt: new Date().toISOString(),
    backfillStart: sim.equity[0]?.date ?? null,
    liveStart: liveBoundary(sim.equity[0]?.date ?? null),
    skippedNoCash: counts.skippedNoCash,
    skippedCap: counts.skippedCap,
    missingPrices: counts.dataMissing,
    suspectPrices: getPortfolioEvents(5000).filter((e) => e.kind === 'suspect_price').length,
    untradableTickers: sim.untradable,
    restatedDays,
  });

  setPortfolioExperiment(experiment);

  return {
    ok: true,
    daysWritten,
    restatedDays,
    rebuilt,
    pricesFetched: priceSync.fetched,
    suspectPoints: priceSync.suspect.length,
    missingPriceTickers: priceSync.missing,
  };
}

/**
 * The backfill → live boundary, or `null` when there is no backfilled portion.
 *
 * After the 2026-09-01 reset the book opens WEEKS after the live `signals`
 * table started covering it, so every day of the curve is live. Reporting
 * 2026-08-15 then would draw a "Live from Aug 15" divider on the very first
 * point of a curve that begins in September — a boundary marked inside a window
 * that does not contain it. `null` is what the UI reads as "all of this is
 * live", and the divider is simply not drawn.
 */
function liveBoundary(firstDay: string | null): string | null {
  const live = getPortfolioLiveStart();
  if (!live || !firstDay) return live;
  return live <= firstDay ? null : live;
}

function countEvents(events: readonly PortfolioEvent[]): {
  skippedNoCash: number;
  skippedCap: number;
  dataMissing: number;
} {
  let skippedNoCash = 0;
  let skippedCap = 0;
  let dataMissing = 0;
  for (const e of events) {
    if (e.kind === 'skipped_no_cash') skippedNoCash++;
    else if (e.kind === 'skipped_cap') skippedCap++;
    else if (e.kind === 'data_missing') dataMissing++;
  }
  return { skippedNoCash, skippedCap, dataMissing };
}

/**
 * Wipe the SIMULATION and run it again from scratch. Prices, signals and
 * labeled outcomes are never touched — only the derived book. Reachable from
 * the UI solely through an explicitly confirmed button.
 */
export async function rebuildPortfolio(): Promise<PortfolioSyncReport> {
  clearPortfolio();
  return syncPortfolio();
}

export async function updatePortfolioConfig(partial: Partial<PortfolioConfig>): Promise<PortfolioSyncReport> {
  const before = getPortfolioConfig();
  const after = setPortfolioConfig(partial);
  // Different parameters mean a different book. Keeping the old curve under new
  // labels would show a chart that was never computed with the numbers beside it.
  const changed = (Object.keys(after) as (keyof PortfolioConfig)[]).some((k) => after[k] !== before[k]);
  return changed ? rebuildPortfolio() : syncPortfolio();
}

/**
 * Publish the current state as `public/data/portfolio.json` for the hosted
 * build. `readOnly` is stamped in here rather than in the UI: a browser can
 * neither reach Yahoo nor write SQLite, so the tab must not offer Sync,
 * Rebuild or the settings form there.
 *
 * Returns the number of points written. Never throws — publishing is the last
 * thing a run does, and a full directory must not fail a completed simulation.
 */
export function writePortfolioJson(outDir: string): number {
  try {
    const state = getPortfolioState();
    nodeFs.mkdirSync(outDir, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(outDir, 'portfolio.json'),
      JSON.stringify({ ...state, meta: { ...state.meta, readOnly: true } }),
    );
    return state.equity.length;
  } catch (err) {
    console.error('[portfolio] publishing portfolio.json failed (non-fatal):', err);
    return 0;
  }
}

// ── Read model ────────────────────────────────────────────────────────────

export function getPortfolioState(): PortfolioState {
  const config = getPortfolioConfig();
  const runMeta = getPortfolioRunMeta();
  const equity = getPortfolioEquity();
  const positions = getPortfolioPositions();
  const events = getPortfolioEvents();
  const last = equity[equity.length - 1] ?? null;

  const openRaw = positions.filter((p) => !p.exitDate);
  const earliestOpen = openRaw.reduce((date, p) => p.entryDate < date ? p.entryDate : date, last?.date ?? '');
  const marks = last ? getPriceBook(openRaw.map((p) => p.ticker), earliestOpen) : {};

  const open: PortfolioOpenPosition[] = last
    ? openRaw.map((p) => {
        const series = marks[p.ticker] ?? {};
        const priceAsOf = Object.keys(series)
          .filter((d) => d >= p.entryDate && d <= last.date && Number.isFinite(series[d]) && series[d] > 0)
          .sort().at(-1) ?? null;
        // A high-water mark is not the last traded price. Keep the same
        // carry-forward mark as the simulator and disclose its age.
        const mark = priceAsOf ? series[priceAsOf] : null;
        const position = toOpenPosition(p, mark, last.date, last.equity, config);
        return { ...position, priceAsOf, priceStale: priceAsOf !== last.date,
          nearestBarrier: priceAsOf === last.date ? position.nearestBarrier : null,
          nearestBarrierPct: priceAsOf === last.date ? position.nearestBarrierPct : null };
      })
    : [];
  const closed: PortfolioClosedPosition[] = positions
    .filter((p) => !!p.exitDate)
    .map(toClosedPosition)
    .sort((a, b) => (b.exitDate ?? '').localeCompare(a.exitDate ?? ''));

  return {
    // The parameters the STORED curve was built with — never the current draft.
    config: runMeta?.config ?? config,
    insiderOnly: getPortfolioExperiment(INSIDER_ONLY_ID),
    meta: {
      available: equity.length > 0,
      firstDate: equity[0]?.date ?? null,
      lastDate: last?.date ?? null,
      backfillStart: runMeta?.backfillStart ?? equity[0]?.date ?? null,
      liveStart: runMeta?.liveStart ?? null,
      lastRun: runMeta?.builtAt ?? null,
      skippedNoCash: runMeta?.skippedNoCash ?? 0,
      skippedCap: runMeta?.skippedCap ?? 0,
      missingPrices: runMeta?.missingPrices ?? 0,
      suspectPrices: runMeta?.suspectPrices ?? 0,
      untradableTickers: runMeta?.untradableTickers ?? [],
      restatedDays: runMeta?.restatedDays ?? 0,
      priceAsOf: getPriceAsOf(),
      readOnly: false,
      note: equity.length
        ? null
        : config.inceptionDate && config.inceptionDate > todayYmd()
          ? `The book opens on ${config.inceptionDate}. Nothing is simulated before then.`
          : 'No run yet — press Sync to build the curve from stored signal history.',
    },
    equity,
    open,
    closed,
    events,
    stats: computeStats(equity, closed, open, runMeta?.config ?? config),
  };
}
