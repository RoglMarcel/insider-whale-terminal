/**
 * Testing-portfolio runner (v1.4.0).
 *
 *   npm run portfolio:sync            — incremental: new days only
 *   npm run portfolio:sync -- --rebuild
 *
 * Tops the adjusted-close cache up, replays the rules over every trading day
 * that is not yet in `portfolio_equity`, and publishes `public/data/portfolio.json`
 * so the hosted build has something to read. This is the same code path the
 * desktop app runs after a scrape — there is no separate "CI" simulation.
 *
 * Failures are reported to the workflow; usable data can still be deployed.
 */
import path from 'node:path';
import { recordUpdate } from './update-report';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../electron/database';
import { getPortfolioState, rebuildPortfolio, syncPortfolio } from '../electron/portfolio';

const pct = (v: number | null | undefined): string =>
  v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

async function main(): Promise<void> {
  const dbPath = (process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'insider-tracker.db')).trim();
  if (!fs.existsSync(dbPath)) {
    console.log(`[portfolio] no DB at ${dbPath} — nothing to simulate.`);
    throw new Error('Database unavailable');
  }
  const rebuild = process.argv.includes('--rebuild');
  initDatabase(dbPath);

  console.log(`[portfolio] ${rebuild ? 'REBUILD' : 'sync'} · ${dbPath}`);
  const report = rebuild ? await rebuildPortfolio() : await syncPortfolio();

  if (!report.ok) {
    console.log(`[portfolio] not run: ${report.reason}`);
    // The JSON is republished ANYWAY. A reset whose inception is still in the
    // future reports "not run" by design, and returning here would leave the
    // previous book's curve on the hosted site until the first session settles.
    const empty = publishPortfolio();
    console.log(`[portfolio] wrote public/data/portfolio.json (${empty} point(s))`);
    closeDatabase();
    const expected = report.reason?.startsWith('the book opens on ') || report.reason === 'no signal has ever reached the entry threshold';
    recordUpdate(expected ? 'skipped' : 'failed', expected ? 'not_ready' : 'update_failed');
    if (!expected) process.exitCode = 1;
    return;
  }

  const state = getPortfolioState();
  const s = state.stats;
  const max = s.windows.find((w) => w.key === 'max');
  const last = state.equity[state.equity.length - 1];

  console.log(
    `[portfolio] ${report.pricesFetched} price series fetched · ` +
      `${report.daysWritten} new day(s) · ${report.suspectPoints} suspect point(s) ignored` +
      // The precise reason is logged by syncPortfolio itself, one line up.
      (report.rebuilt ? ' · ↻ curve REBUILT from scratch' : '') +
      (report.restatedDays ? ` · ⚠ ${report.restatedDays} stored day(s) drifted after a price restatement` : ''),
  );

  if (last) {
    console.log(
      `[portfolio] ${state.meta.firstDate} → ${state.meta.lastDate} · ` +
        `equity $${last.equity.toFixed(2)} (${pct(max?.portfolio)}) vs SPY $${last.benchmark.toFixed(2)} (${pct(max?.benchmark)}) · ` +
        `edge ${pct(max?.diff)}`,
    );
    console.log(
      `[portfolio] trades ${s.trades.closed} closed / ${s.trades.open} open · ` +
        `hit rate ${s.trades.winRate == null ? 'n/a' : `${(s.trades.winRate * 100).toFixed(0)}%`} · ` +
        `avg trade alpha ${pct(s.trades.avgTradeAlpha)} (n=${s.trades.alphaN}) · ` +
        `max DD ${pct(s.maxDrawdown.portfolio)}`,
    );
    if (state.meta.untradableTickers.length) {
      console.log(`[portfolio] not tradable (no price series): ${state.meta.untradableTickers.join(', ')}`);
    }
  }

  const points = publishPortfolio();
  console.log(`[portfolio] wrote public/data/portfolio.json (${points} point(s))`);

  const missing = [...new Set([
    ...(report.missingPriceTickers ?? []),
    ...state.open.filter((p) => p.priceStale).map((p) => p.ticker),
    ...(state.insiderOnly?.state.open.filter((p) => p.priceStale).map((p) => p.ticker) ?? []),
  ])].sort();
  if (missing.length) console.warn(`[portfolio] incomplete price refresh: ${missing.join(', ')}; cached prices retained`);
  const incomplete = missing.length > 0 || !state.insiderOnly;
  recordUpdate(incomplete ? 'partial' : 'success', incomplete ? 'prices_unavailable' : 'updated', missing.length, missing, state.meta.priceAsOf ?? undefined);
  closeDatabase();
}

function publishPortfolio(): number {
  const state = getPortfolioState();
  const directory = path.resolve(process.cwd(), 'public', 'data');
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, 'portfolio.json.tmp');
  fs.writeFileSync(temporary, JSON.stringify({ ...state, meta: { ...state.meta, readOnly: true } }));
  fs.renameSync(temporary, path.join(directory, 'portfolio.json'));
  return state.equity.length;
}

main().catch((err) => {
  console.error('[portfolio] THREW:', err);
  recordUpdate('failed', 'update_failed');
  process.exit(1);
});
