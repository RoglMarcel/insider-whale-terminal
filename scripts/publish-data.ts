/**
 * Publish-only runner — writes `public/data/*.json` from the committed history
 * DB WITHOUT scraping anything.
 *
 * This is the CI fast path for a desktop publish. When the desktop app pushes a
 * scrape (see electron/webPublish.ts), the rows are already in
 * `data/insider-tracker.db` and are RICHER than a cloud run can produce — they
 * include the login-gated options flow that only works from a real machine.
 * Re-scraping on the runner would spend several minutes to produce a weaker
 * snapshot and overwrite the reason the push happened, so the workflow calls
 * this instead and goes straight to build + deploy.
 *
 * Shape-compatible with scrape-web.ts's output: the web UI reads the same two
 * files either way and cannot tell which path produced them, apart from
 * `meta.source`.
 */
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getLatestSignals, getScrapeLogs } from '../electron/database';
import { writePortfolioJson } from '../electron/portfolio';

function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function main(): void {
  const outDir = path.resolve(process.cwd(), 'public', 'data');
  const dbPath = path.resolve(process.cwd(), 'data', 'insider-tracker.db');
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(dbPath)) {
    console.error(`[publish-data] no history DB at ${dbPath} — nothing to publish.`);
    process.exit(1);
  }
  initDatabase(dbPath);

  const signals = getLatestSignals();
  const runs = (() => {
    try {
      return getScrapeLogs(12);
    } catch {
      return [];
    }
  })();
  const latestRun = runs[0];

  const meta = {
    generatedAt: new Date().toISOString(),
    signalAsOf: signals.map(s => s.scrapedAt).sort().at(-1) ?? null,
    version: process.env.APP_VERSION ?? readVersion(),
    durationSec: 0,
    status: latestRun?.status ?? 'success',
    signalsFound: signals.length,
    publishedSignals: signals.length,
    vix: latestRun?.vixAtScrape != null ? { value: latestRun.vixAtScrape } : null,
    // A publish-only run performs no scrape, so it observes no source health of
    // its own; the panel is fed by `runs` below, which carries the real history.
    sourceHealth: [],
    newHighConviction: [],
    newCombos: [],
    newNotable: [],
    scoreSurges: [],
    runs,
    source: 'desktop-publish-fastpath',
    errors: [],
  };

  fs.writeFileSync(path.join(outDir, 'signals.json'), JSON.stringify(signals));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  // Whatever the portfolio engine last computed. This does NOT run the
  // simulation (that is `npm run portfolio:sync`); it only makes sure the
  // hosted tab has the stored state even when the sync step was skipped.
  const pfPoints = writePortfolioJson(outDir);
  closeDatabase();

  const withOptions = signals.filter((s) => (s.optionsActivity?.length ?? 0) > 0).length;
  const combos = signals.filter((s) => s.comboSignal || s.breakdown?.politicianComboTier).length;
  console.log(
    `[publish-data] wrote ${signals.length} signal(s) from the history DB · ` +
      `${withOptions} with options · ${combos} combo(s) · ${pfPoints} portfolio point(s) · no scrape performed`,
  );
}

main();
