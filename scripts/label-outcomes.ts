import { tickerIssue } from '../src/lib/ticker-quality';
import { priceTicker, type PriceIdentity } from '../electron/priceSymbols';
import { resolvedTicker } from '../src/lib/ticker-quality';
/**
 * Outcome labeler — turns stored signals into TRAINING DATA (v1.1.13).
 *
 * For every signal whose horizon has ripened, it records the realized
 * SPY-relative alpha into `signal_outcomes`. Runs after each scheduled scrape, so
 * the labeled dataset grows on its own — which is the thing the scoring model
 * actually lacks (the component backtest measured ICs on samples where most
 * components never varied).
 *
 *   npm run label:outcomes
 *
 * Design notes:
 *  - The score is taken from the FIRST sighting of a signal and never recomputed,
 *    so labels can't inherit hindsight.
 *  - Prices are adjusted closes from Yahoo's chart API (same endpoint the app
 *    already uses in stockstats.ts), one request per ticker, cached per run.
 *  - Rows are written once (ON CONFLICT DO NOTHING) — re-running is cheap and
 *    only fills genuine gaps.
 */
import path from 'node:path';
import { recordUpdate } from './update-report';
import fs from 'node:fs';
import { fetchAdjCloseSeries, outcomeCutoff, outcomePricePair, PRICE_REQUEST_GAP_MS, sleep } from '../electron/prices';
import {
  initDatabase,
  closeDatabase,
  getOutcomeBackfillCandidates,
  getOutcomeCandidates,
  getLabeledKeys,
  upsertSignalOutcomes,
  getOutcomeCoverage,
  type SignalOutcome,
} from '../electron/database';

/**
 * Calendar days forward. Extended from [5, 10, 20] in v1.5.0.
 *
 * 20 days was shorter than every horizon the insider-trading literature
 * measures (six to twelve months), so the labeled set could not see the drift
 * it is supposed to be evidence about — it could only ever confirm that the
 * short end decays. The long horizons ripen on their own as the history grows;
 * `insider_trades` starts 2026-04-10, so 180 is not measurable yet and simply
 * writes nothing until it is. Nothing here is retroactive: prices come from
 * adjusted closes that backfill historically, so a horizon added today labels
 * every signal old enough to have ripened.
 */
const HORIZONS = [5, 10, 20, 40, 60, 90, 120, 180] as const; // calendar days forward
const MAX_TICKERS_PER_RUN = Number(process.env.LABEL_MAX_TICKERS ?? 250);

type Series = { date: string; px: number }[];
const cache = new Map<string, Series | null>();

async function fetchSeries(ticker: string, fromYmd: string, identity?: PriceIdentity): Promise<Series | null> {
  const today = new Date().toISOString().slice(0, 10);
  const key = priceTicker(resolvedTicker(ticker, today), today, identity);
  if (cache.has(key)) return cache.get(key)!;
  await sleep(PRICE_REQUEST_GAP_MS);
  const points = await fetchAdjCloseSeries(ticker, { fromYmd, identity });
  const series = points?.length ? points : null;
  cache.set(key, series);
  return series;
}

function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'insider-tracker.db');
  if (!fs.existsSync(dbPath)) {
    console.log(`[label] no DB at ${dbPath} — nothing to label.`);
    throw new Error('Database unavailable');
  }
  initDatabase(dbPath);

  // `signals` is a rolling scrape window (nine days on the shipped history), so
  // on its own it can only ever ripen the SHORTEST horizons. The durable record
  // of everything ever labeled is `signal_outcomes`; unioning it in is what makes
  // the 40/60/90/120/180-day horizons reachable at all. Live rows win on a
  // duplicate key, because they carry the freshest breakdown snapshot.
  const bySignal = getOutcomeCandidates().filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.entryDate));
  const seenKeys = new Set(bySignal.map((c) => `${c.ticker}|${c.entryDate}`));
  const rawCandidates = [
    ...bySignal,
    ...getOutcomeBackfillCandidates().filter(
      (c) => /^\d{4}-\d{2}-\d{2}$/.test(c.entryDate) && !seenKeys.has(`${c.ticker}|${c.entryDate}`),
    ),
  ];
  const quarantined = [...new Set(rawCandidates.filter((c) => tickerIssue(c.ticker)).map((c) => c.ticker))].sort();
  const candidates = rawCandidates.filter((c) => !tickerIssue(c.ticker));
  if (quarantined.length) console.log(`[label] quarantined malformed symbols (history retained): ${quarantined.join(', ')}`);
  const labeled = getLabeledKeys();
  const fromYmd = candidates.map(c => c.entryDate).sort()[0] ?? new Date().toISOString().slice(0, 10);
  const spy = await fetchSeries('SPY', fromYmd);
  const cutoff = spy && outcomeCutoff(spy, new Date().toISOString().slice(0, 10));
  if (!spy || !cutoff) {
    closeDatabase();
    throw new Error('Benchmark unavailable');
  }


  // Only ripe (entry + horizon covered by the benchmark) and not-yet-labeled work.
  // Saturday, holidays and future closes are pending work, not missing prices.
  const todo = candidates.filter((c) =>
    HORIZONS.some((h) => addDays(c.entryDate, h) <= cutoff && !labeled.has(`${c.ticker}|${c.entryDate}|${h}`)),
  );
  // Newest first: delisted / bad tickers never return prices, so they'd otherwise
  // consume the whole per-run budget every time and starve fresh signals.
  const tickers = [
    ...new Set([...todo].sort((a, b) => b.entryDate.localeCompare(a.entryDate)).map((c) => c.ticker)),
  ].slice(0, MAX_TICKERS_PER_RUN);
  console.log(
    `[label] candidates=${candidates.length} (${bySignal.length} live + ${candidates.length - bySignal.length} from signal_outcomes) · ` +
      `already labeled=${labeled.size} · ripe+missing=${todo.length} · tickers this run=${tickers.length}`,
  );
  if (!tickers.length) {
    recordUpdate('skipped', 'no_work', 0, [], undefined, quarantined);
    report();
    closeDatabase();
    return;
  }

  const out: SignalOutcome[] = [];
  let done = 0;
  const missing = new Set<string>();
  for (const ticker of tickers) {
    done++;
    if (done % 50 === 0) console.log(`   …${done}/${tickers.length}`);
    for (const c of todo.filter((x) => x.ticker === ticker)) {
      const series = await fetchSeries(ticker, fromYmd, c);
      if (!series) { missing.add(ticker); continue; }
      const entryPair = outcomePricePair(series, spy, c.entryDate);
      if (!entryPair) { missing.add(ticker); continue; }
      const { equity: entry, benchmark: spyEntry } = entryPair;
      for (const h of HORIZONS) {
        const key = `${c.ticker}|${c.entryDate}|${h}`;
        if (labeled.has(key)) continue;
        const target = addDays(c.entryDate, h);
        if (target > cutoff) continue;
        const exitPair = outcomePricePair(series, spy, target);
        if (!exitPair) { missing.add(ticker); continue; }
        const { equity: exit, benchmark: spyExit } = exitPair;
        const ret = exit.px / entry.px - 1;
        const spyRet = spyExit.px / spyEntry.px - 1;
        out.push({
          ticker: c.ticker,
          entryDate: c.entryDate,
          horizon: h,
          entryPrice: entry.px,
          exitPrice: exit.px,
          ret,
          spyRet,
          alpha: ret - spyRet,
          score: c.score,
          conviction: c.conviction,
          breakdown: c.breakdown,
        });
      }
    }
  }

  const written = upsertSignalOutcomes(out);
  console.log(`[label] wrote ${written} new labeled outcome(s).`);
  const deferred = new Set(todo.map((c) => c.ticker)).size > tickers.length;
  if (missing.size) console.warn(`[label] missing historical prices: ${[...missing].sort().join(', ')}`);
  recordUpdate(missing.size || deferred ? 'partial' : 'success', missing.size ? 'prices_unavailable' : deferred ? 'work_remaining' : 'updated', missing.size, [...missing], undefined, quarantined);
  report();
  closeDatabase();
}

/** Honest coverage: how much data exists, and is each component measurable yet? */
function report(): void {
  const { perHorizon, components } = getOutcomeCoverage();
  console.log('\n── Trainingsdaten ───────────────────────────');
  if (!perHorizon.length) {
    console.log('  (noch keine gelabelten Outcomes)');
  } else {
    for (const h of perHorizon) {
      // Power rule of thumb: SE(IC) ≈ 1/√n → n≈780 detects IC 0.10 at 80% power.
      const need = 780;
      const pct = Math.min(100, Math.round((h.n / need) * 100));
      console.log(`  ${String(h.horizon).padStart(3)}d Horizont: n=${String(h.n).padStart(5)}   ${pct}% des Ziels (n≈${need} für IC 0.10)`);
    }
  }
  if (components.length && components[0].total > 0) {
    console.log('\n── Messbarkeit je Komponente (20d) ──────────');
    for (const c of [...components].sort((a, b) => b.varying - a.varying)) {
      const pct = (c.varying / c.total) * 100;
      const verdict = pct >= 30 ? 'messbar' : pct >= 10 ? 'grenzwertig' : 'NICHT messbar';
      console.log(`  ${c.name.padEnd(18)} variiert in ${String(c.varying).padStart(5)}/${c.total} (${pct.toFixed(1)}%)  ${verdict}`);
    }
  }
}

main().catch((err) => {
  console.error('[label] THREW:', err);
  recordUpdate('failed', 'update_failed');
  process.exit(1);
});
