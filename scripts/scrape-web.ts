/**
 * Headless web runner (v1.1.2) — the "scrape-to-static" entry point.
 *
 * Runs the SAME orchestrator the desktop app uses (`runScrape`) on a plain Node
 * runtime (e.g. GitHub Actions), then writes the result as static JSON that the
 * hosted web UI reads directly. No Electron, no window — see `electron-stub.ts`
 * for the tiny `electron` shim esbuild aliases in.
 *
 * Output (committed by the workflow, served by the web build):
 *   public/data/signals.json  — Signal[] (scored + ranked, exactly as desktop)
 *   public/data/meta.json     — { generatedAt, version, vix, status, sourceHealth, ... }
 *
 * Source policy: a CONSERVATIVE 🟢 set that works from a datacenter IP without
 * login or Cloudflare clearance. Flip the flags in `WEB_SOURCES` below to try
 * more once the block-test (tutorial step 6) is done. Congress / sell-side /
 * activist side-pipelines always run (they are fetch-based and 🟢).
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron'; // aliased to scripts/electron-stub.ts (see the scrape:web npm script)
import { runScrape } from '../electron/scraper';
import {
  initDatabase,
  closeDatabase,
  getMostRecentSessionSignals,
  getLatestSignals,
  getScrapeLogs,
} from '../electron/database';
import { fetchVix } from '../electron/vix';
import { writePortfolioJson } from '../electron/portfolio';
import { DEFAULT_SETTINGS, SCRAPER_SOURCES, type AppSettings, type ScraperSource } from '../src/types';

// Only robust, browser-optional sources by default. secform4/openinsider/
// insidermonitor are static HTML; edgar is authoritative XML over fetch.
const WEB_SOURCES: Record<ScraperSource, boolean> = {
  edgar: true,
  openinsider: true,
  insidermonitor: true,
  secform4: true,
  // Off by default — Cloudflare / JS-render / login make these unreliable from
  // a CI datacenter IP. Re-enable individually after testing (see tutorial §6).
  finviz: false,
  marketbeat: false,
  quiverquant: false,
  // Instagram renders client-side and rate-limits datacenter IPs hard; the
  // caption route needs no login, so this is worth a block-test before enabling.
  ceowatcher: false,
  barchart: false,
  optionstrat: false,
  insiderfinance: false,
  marketbeatoptions: false,
};

/**
 * Login-gated sources in CI: the user pastes exported Playwright `storageState`
 * blobs into the GitHub secret SCRAPE_SESSIONS as a JSON map
 *   { "barchart": {cookies:[…],origins:[…]}, "finviz": {…}, … }
 * We write each to the exact session file `auth.ts` reads (RAW: = plaintext, no
 * OS keychain in CI), which makes `sourceUnlocked()` return true and injects the
 * cookies via `loadMergedStorageState()` — zero changes to auth/orchestrator.
 * Only source keys (not e.g. twitter/valuation) get auto-enabled here.
 * NOTE: never log the blob contents; only the key names.
 */
function applySessions(): ScraperSource[] {
  const raw = process.env.SCRAPE_SESSIONS;
  if (!raw) return [];
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(raw);
  } catch {
    console.warn('[scrape-web] SCRAPE_SESSIONS is set but not valid JSON — ignoring it.');
    return [];
  }
  const dir = path.join(app.getPath('userData'), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const sourceKeys = new Set<string>(SCRAPER_SOURCES.map((s) => s.key));
  const enabled: ScraperSource[] = [];
  for (const [key, state] of Object.entries(map)) {
    if (!state || typeof state !== 'object') continue;
    fs.writeFileSync(path.join(dir, `${key}.session`), 'RAW:' + JSON.stringify(state));
    if (sourceKeys.has(key)) enabled.push(key as ScraperSource);
  }
  console.log(
    `[scrape-web] injected ${Object.keys(map).length} session(s); unlocked gated sources: ` +
    (enabled.length ? enabled.join(', ') : '(none are scraper sources)'),
  );
  return enabled;
}

async function main(): Promise<void> {
  const version = process.env.APP_VERSION ?? readVersion();
  const outDir = path.resolve(process.cwd(), 'public', 'data');
  const dbDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(dbDir, { recursive: true });

  // Ephemeral DB in v1.1.2 (fresh each run). The orchestrator requires an
  // initialized DB; persisting it across runs (for history/track-records) is a
  // later step — see tutorial "Was v1.1.2 noch NICHT kann".
  const dbPath = path.join(dbDir, 'insider-tracker.db');
  console.log(`[scrape-web] init DB at ${dbPath} (${fs.existsSync(dbPath) ? 'existing — history preserved' : 'fresh'})`);
  initDatabase(dbPath);

  // Unlock any login-gated sources whose cookies were supplied via SCRAPE_SESSIONS.
  const sessionSources = applySessions();
  const sources: Record<ScraperSource, boolean> = { ...WEB_SOURCES };
  for (const key of sessionSources) sources[key] = true;

  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    sources,
    headless: true,
    scheduleEnabled: false, // the CI cron is the scheduler; nothing schedules in-process
  };

  // Snapshot the previous run's tickers BEFORE scraping (for "new notable" push).
  const prevTickers = new Set(getMostRecentSessionSignals().map((s) => s.ticker));

  console.log('[scrape-web] fetching VIX…');
  const vix = await fetchVix().catch(() => null);

  console.log('[scrape-web] starting scrape (sources: ' +
    Object.entries(WEB_SOURCES).filter(([, v]) => v).map(([k]) => k).join(', ') + ')…');
  const started = Date.now();
  const result = await runScrape({ settings, vix: vix?.value, vixQuote: vix });
  const secs = Math.round((Date.now() - started) / 1000);

  // Notable new WATCH-tier entrants (HIGH is unreachable without options flow, so
  // notifying only on HIGH would never fire in the 🟢-only build).
  const NOTABLE_MIN_SCORE = 65;
  const newNotable = result.signals
    .filter((s) => s.score >= NOTABLE_MIN_SCORE && !prevTickers.has(s.ticker))
    .map((s) => s.ticker);

  /**
   * Publish the ACTIVE UNION from the DB, not just this run's own output.
   *
   * The cloud run only scrapes 🟢 sources, so publishing `result.signals` alone
   * dropped everything the desktop published from login-gated sources (finviz /
   * marketbeat / barchart / optionstrat / insiderfinance) — and with the insider
   * leg missing, their COMBOs disappeared too. `getLatestSignals()` returns the
   * newest signal per ticker within the 4-day active window (same rule the desktop
   * dashboard uses), so desktop-published tickers stay visible and expire on their
   * own, while this run refreshes whatever it re-scraped.
   */
  let published = result.signals;
  try {
    const union = getLatestSignals();
    if (union.length) published = union;
  } catch (err) {
    console.warn('[scrape-web] getLatestSignals failed — publishing this run only:', err);
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    source: 'cloud-scrape',
    signalAsOf: published.map(s => s.scrapedAt).sort().at(-1) ?? null,
    version,
    durationSec: secs,
    status: result.status,
    signalsFound: result.signalsFound,
    publishedSignals: published.length,
    vix: vix ?? null,
    sourceHealth: result.sourceHealth ?? [],
    newHighConviction: result.newHighConviction,
    newCombos: result.newCombos,
    newNotable,
    scoreSurges: result.scoreSurges ?? [],
    // Last runs, straight from the DB in the shape the UI already expects
    // (ScrapeLogEntry[]). Without these the hosted History view is three empty
    // cards, and Source Health has no rolling window to compute a median from.
    runs: safeRuns(),
    // Keep the payload small — surface only the error messages, not stacks.
    errors: result.errors.map((e) => `${e.source}: ${e.message}`),
  };

  fs.writeFileSync(path.join(outDir, 'signals.json'), JSON.stringify(published));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  // Stored portfolio state, so the tab has data even if the later
  // `portfolio:sync` step fails. The simulation itself runs in that step.
  writePortfolioJson(outDir);

  const withOptions = published.filter((s) => (s.optionsActivity?.length ?? 0) > 0).length;
  console.log(
    `[scrape-web] done in ${secs}s · status=${result.status} · ` +
    `scraped ${result.signals.length} · published ${published.length} (active union) · ` +
    `${withOptions} with options · vix=${vix?.value ?? 'n/a'} · ${result.errors.length} issue(s)`,
  );
  if (result.errors.length) {
    for (const e of result.errors.slice(0, 10)) console.log(`   ⚠ ${e.source}: ${e.message}`);
  }

  closeDatabase();

  // Exit non-zero only on a HARD failure (persist error / nothing ran), so a
  // partial scrape (one flaky source) still publishes the good signals.
  process.exit(result.status === 'failed' ? 1 : 0);
}

/** Recent scrape sessions for the hosted History view; never fails the run. */
function safeRuns(): ReturnType<typeof getScrapeLogs> {
  try {
    return getScrapeLogs(12);
  } catch {
    return [];
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

main().catch((err) => {
  console.error('[scrape-web] THREW:', err);
  process.exit(1);
});
