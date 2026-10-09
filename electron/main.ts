import { pathToFileURL } from 'node:url';
import { externalWebUrl, trustedRenderer, requirePlatform } from './securityBoundary';
import { app, BrowserWindow, ipcMain, shell, Menu, Notification, dialog, globalShortcut } from 'electron';
import type { Browser } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { autoUpdater } from 'electron-updater';
import { reduceSoftwareUpdate, type SoftwareUpdateState, type SoftwareUpdateEvent } from '../src/types/softwareUpdate';
import type {
  AppSettings,
  ScrapeResult,
  SignalFilter,
  InsiderTrackRecord,
  SignalPerformance,
  AlertRule,
  ScoringConfig,
  PortfolioConfig,
} from '../src/types';
import { CONVICTION_THRESHOLDS } from '../src/types';
import { IPC } from './ipc-channels';
import {
  initDatabase,
  closeDatabase,
  getLatestSignals,
  getSignalByTicker,
  getSignalHistory,
  getFilteredSignals,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getSettings,
  setSettings,
  getScrapeLogs,
  getLastScrapeTime,
  getMostRecentSessionSignals,
  getTrackRecord,
  upsertTrackRecord,
  clearDatabase,
  updateEarnings,
  getNewsItems,
  getNewsForTicker,
  getAlertRules,
  addAlertRule,
  deleteAlertRule,
  setAlertRuleEnabled,
  insertBacktestRun,
  getLatestBacktestRun,
  getShadowScoringConfig,
  setShadowScoringConfig,
} from './database';
import { computePerformanceReport } from './performance';
import { getPortfolioState, rebuildPortfolio, syncPortfolio, updatePortfolioConfig } from './portfolio';
import { getBacktestState, retryBacktest } from './backtest';
import { runScrape, getScrapeStatus, fetchStockAnalysisEarnings } from './scraper';
import { publishToWeb } from './webPublish';
import { launchBrowser, createContext } from './scraper/browser';
import { yahooTicker } from './scraper/util';
import { scrapeFinvizEarnings } from './scraper/finviz';
import { fetchInsiderTrackRecord } from './scraper/insiderHistory';
import { configureScheduler, stopScheduler, syncTaskScheduler } from './scheduler';
import {
  notifyForSignals,
  notifyCombos,
  notifyScoreSurges,
  notifySourceHealth,
  notifyAlertHits,
  notifyFilingEvents,
  seedNotified,
} from './notifications';
import { startVixPolling, stopVixPolling, getCachedVix, fetchVix } from './vix';
import {
  authStatus,
  startLogin,
  saveLogin,
  cancelLogin,
  logout,
  closeAllLogins,
  loadMergedStorageState,
} from './auth';

const TRACK_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
const rendererEntry = isDev ? new URL(process.env.VITE_DEV_SERVER_URL!).href : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
let mainWindow: BrowserWindow | null = null;

// ──────────────────────────────────────────────────────────────────────────
// Window
// ──────────────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#050507',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open external links in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = externalWebUrl(url);
    if (allowed) void shell.openExternal(allowed).catch(() => undefined);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== rendererEntry.split('#')[0]) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());

  if (isDev) {
    mainWindow.loadURL(rendererEntry);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// On-demand Chromium pool — bounds how many headless browsers run at once for
// modal-triggered fetches (track records, earnings fallback). Opening
// a multi-insider modal previously launched one Chromium PER insider in parallel.
// ──────────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_BROWSERS = 2;
let activeBrowserOps = 0;
const browserWaiters: Array<() => void> = [];

async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowserOps < MAX_CONCURRENT_BROWSERS) {
    activeBrowserOps++;
    return;
  }
  // Wait for a freed slot; the releaser hands it over without changing the count.
  await new Promise<void>((resolve) => browserWaiters.push(resolve));
}

function releaseBrowserSlot(): void {
  const next = browserWaiters.shift();
  if (next) next();
  else activeBrowserOps--;
}

/** Run a task with a pooled Chromium instance, capping total concurrency. */
async function withPooledBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  await acquireBrowserSlot();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(getSettings().headless);
    return await fn(browser);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    releaseBrowserSlot();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Scrape pipeline (shared by manual trigger + scheduler)
// ──────────────────────────────────────────────────────────────────────────

async function triggerScrape(): Promise<ScrapeResult> {
  const settings = getSettings();
  const vixQuote = getCachedVix();
  const result = await runScrape({
    settings,
    vix: vixQuote?.value,
    vixQuote,
    onStatus: (status) => broadcast(IPC.scraperStatusUpdate, status),
  });

  // Combo signals always notify; other high-conviction signals respect the threshold.
  notifyCombos(result.newCombos, result.signals, mainWindow);
  notifyScoreSurges(result.scoreSurges, mainWindow);
  // When threshold is at/above HIGH, prefer the precomputed new-HIGH list so the
  // orchestrator's newHighConviction path is actually used (not dead).
  if (settings.notificationThreshold >= CONVICTION_THRESHOLDS.high && result.newHighConviction.length) {
    const highSet = new Set(result.newHighConviction);
    notifyForSignals(
      result.signals.filter((s) => highSet.has(s.ticker)),
      settings.notificationThreshold,
      mainWindow,
    );
  } else {
    notifyForSignals(result.signals, settings.notificationThreshold, mainWindow);
  }
  notifySourceHealth(result.sourceHealth);
  notifyAlertHits(result.alertHits, mainWindow);
  notifyFilingEvents(result.filingEvents, mainWindow);
  broadcast(IPC.appSignalsUpdated, getLatestSignals());

  // Roll the testing portfolio forward. Deliberately NOT awaited into the
  // scrape's result: it talks to Yahoo, and a scrape that already succeeded
  // must never be reported as failed because a price fetch timed out.
  const portfolioSync = syncPortfolio()
    .then((r) => {
      if (r.ok) console.log(`[main] portfolio: +${r.daysWritten} day(s), ${r.pricesFetched} series fetched`);
      else console.log(`[main] portfolio not run: ${r.reason}`);
      broadcast(IPC.appSignalsUpdated, getLatestSignals());
    })
    .catch((err) => console.error('[main] portfolio sync threw (non-fatal):', err));

  // Push the run to the web terminal. Deliberately NOT awaited into the scrape's
  // own result: publishing talks to git and the network, and a scrape that
  // already succeeded locally must not be reported as failed because a push did
  // not land. Errors are surfaced to the UI instead.
  if (settings.webPublishEnabled) {
    void portfolioSync.then(() => publishToWeb({ repoPath: settings.webPublishRepoPath || undefined }))
      .then((res) => {
        if (res.pushed) {
          console.log('[main] web publish: pushed', res.copied);
        } else if (res.skipped) {
          console.log(`[main] web publish skipped: ${res.skipped}`);
        } else if (res.error) {
          console.error(`[main] web publish failed: ${res.error}`);
        }
        broadcast(IPC.webPublishStatus, res);
      })
      .catch((err) => {
        console.error('[main] web publish threw:', err);
        broadcast(IPC.webPublishStatus, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  return result;
}

async function fetchTrackRecord(
  name: string,
  role?: string,
  url?: string,
): Promise<InsiderTrackRecord | null> {
  const cached = getTrackRecord(name);
  const fresh = cached && (Date.now() - Date.parse(cached.lastUpdated) < TRACK_RECORD_TTL_MS) && (cached.totalTrades > 0 || !!cached.error);
  if (cached && fresh) return cached;
  if (!url) {
    return cached ?? {
      insiderName: name,
      insiderRole: role || null,
      totalTrades: 0,
      profitable3m: 0,
      profitable6m: 0,
      accuracy3m: 0,
      accuracy6m: 0,
      avgReturn3m: 0,
      lastUpdated: new Date().toISOString(),
      recentTrades: [],
      error: 'No history page available for this insider.',
    };
  }

  try {
    return await withPooledBrowser(async (browser) => {
      const context = await createContext(browser, loadMergedStorageState());
      const record = await fetchInsiderTrackRecord(context, name, url, role);
      await context.close().catch(() => undefined);
      if (record.totalTrades > 0 || record.error === 'No post-trade performance data yet.' || record.error === 'No history page available for this insider.') {
        upsertTrackRecord(record); // cache clean scrapes to avoid repeating slow launches
      }
      return record;
    });
  } catch {
    return cached ?? null;
  }
}


async function fetchEarningsForTicker(ticker: string): Promise<{ earningsDate?: string; daysToEarnings?: number; earningsTiming?: string }> {
  // Try Stock Analysis first (fast GET — reuses the orchestrator's fetch+parse).
  try {
    const parsed = await fetchStockAnalysisEarnings(ticker);
    if (parsed?.earningsDate) {
      updateEarnings(ticker, parsed.earningsDate, parsed.earningsTiming ?? null, parsed.daysToEarnings ?? null);
      return { earningsDate: parsed.earningsDate, daysToEarnings: parsed.daysToEarnings, earningsTiming: parsed.earningsTiming };
    }
  } catch (err) {
    console.error(`Dynamic earnings fetch from Stock Analysis failed for ${ticker}:`, err);
  }

  // Fallback to the Finviz Playwright quote page scraper (pooled browser).
  try {
    return await withPooledBrowser(async (browser) => {
      const context = await createContext(browser, loadMergedStorageState());
      const earningsMap = await scrapeFinvizEarnings(context, [ticker], 1);
      await context.close().catch(() => undefined);
      const e = earningsMap.get(ticker);
      if (e && e.earningsDate) {
        updateEarnings(ticker, e.earningsDate, e.earningsTiming ?? null, e.daysToEarnings ?? null);
        return { earningsDate: e.earningsDate, daysToEarnings: e.daysToEarnings, earningsTiming: e.earningsTiming };
      }
      return {};
    });
  } catch (err) {
    console.error(`Dynamic earnings fetch fallback failed for ${ticker}:`, err);
    return {};
  }
}

// ──────────────────────────────────────────────────────────────────────────
// "Follow this signal" P&L + CSV export (Feature 2 / 8)
// ──────────────────────────────────────────────────────────────────────────

const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function yahooAdjMap(symbol: string): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker(symbol) || symbol)}?interval=1d&range=2y`,
      { headers: { 'User-Agent': YF_UA }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return map;
    const r = (await res.json() as any)?.chart?.result?.[0];
    const ts: number[] = r?.timestamp || [];
    const adj: number[] = r?.indicators?.adjclose?.[0]?.adjclose || r?.indicators?.quote?.[0]?.close || [];
    ts.forEach((t, i) => {
      const v = adj[i];
      if (v != null && Number.isFinite(v)) map[new Date(t * 1000).toISOString().slice(0, 10)] = v;
    });
  } catch {
    /* leave empty */
  }
  return map;
}

/** Walk calendar days in pure UTC so US timezones don't shift YYYY-MM-DD keys. */
function priceOnOrAfter(map: Record<string, number>, dateStr: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return undefined;
  for (let i = 0; i < 6; i++) {
    const s = d.toISOString().slice(0, 10);
    if (map[s] != null) return map[s];
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return undefined;
}

function latestPrice(map: Record<string, number>): number | undefined {
  const keys = Object.keys(map).sort();
  return keys.length ? map[keys[keys.length - 1]] : undefined;
}

async function getSignalPerformance(ticker: string): Promise<SignalPerformance | null> {
  const sym = ticker.trim().toUpperCase();
  const history = getSignalHistory(sym);
  const first = history[0];
  const sinceDate =
    first?.tradeDate && /^\d{4}-\d{2}-\d{2}$/.test(first.tradeDate)
      ? first.tradeDate
      : first?.scrapedAt
        ? first.scrapedAt.slice(0, 10)
        : null;
  if (!sinceDate) return null;

  const [stockMap, spyMap] = await Promise.all([yahooAdjMap(sym), yahooAdjMap('SPY')]);
  const entryPrice = priceOnOrAfter(stockMap, sinceDate);
  const currentPrice = latestPrice(stockMap);
  if (entryPrice == null || currentPrice == null) return { ticker: sym, sinceDate };

  const returnPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  const spyEntry = priceOnOrAfter(spyMap, sinceDate);
  const spyNow = latestPrice(spyMap);
  const alphaPct = spyEntry && spyNow ? returnPct - ((spyNow - spyEntry) / spyEntry) * 100 : undefined;

  return {
    ticker: sym,
    sinceDate,
    entryPrice: Math.round(entryPrice * 100) / 100,
    currentPrice: Math.round(currentPrice * 100) / 100,
    returnPct: Math.round(returnPct * 10) / 10,
    alphaPct: alphaPct != null ? Math.round(alphaPct * 10) / 10 : undefined,
  };
}

async function exportSignalsCsv(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  try {
    const signals = getLatestSignals();
    const headers = [
      'Ticker', 'Company', 'Sector', 'Score', 'Conviction', 'InsiderCount', 'DollarVolume', 'TopInsider', 'TopRole',
      'TradeDate', 'FilingDate', 'Combo', 'BigPlayer', 'EarningsDate', 'DaysToEarnings', 'ScrapedAt',
    ];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const s of signals) {
      lines.push(
        [
          s.ticker, s.companyName ?? '', s.sector ?? '', s.score, s.convictionLevel, s.insiderCount, Math.round(s.totalDollarVolume),
          s.topInsiderName ?? '', s.topInsiderRole ?? '', s.tradeDate ?? '', s.filingDate ?? '',
          s.comboSignal ? 'yes' : '', s.bigPlayer ? 'yes' : '', s.earningsDate ?? '', s.daysToEarnings ?? '', s.scrapedAt,
        ].map(esc).join(','),
      );
    }
    const csv = lines.join('\n');
    const opts = {
      title: 'Export signals to CSV',
      defaultPath: `insider-signals-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    };
    const res = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, csv, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let softwareUpdate:SoftwareUpdateState={status:'idle',version:''};
const updateEvent=(event:SoftwareUpdateEvent)=>{softwareUpdate=reduceSoftwareUpdate(softwareUpdate,event);};
let checkingUpdate:Promise<SoftwareUpdateState>|undefined;
async function checkSoftwareUpdates():Promise<SoftwareUpdateState>{
  if(checkingUpdate)return checkingUpdate;
  if(softwareUpdate.status==='downloaded')return softwareUpdate;
  updateEvent({type:'checking'});
  const task=(async()=>{
    try{await autoUpdater.checkForUpdatesAndNotify();}
    catch(error){const message=error instanceof Error?error.message:String(error);updateEvent({type:'error',message});broadcast(IPC.updateError,message);}
    return softwareUpdate;
  })();
  checkingUpdate=task;
  try{return await task;}finally{checkingUpdate=undefined;}
}

function initAutoUpdater(): void {
  if (!app.isPackaged) return;

  // Custom log file to debug auto-updater issues in production
  const logFilePath = path.join(app.getPath('userData'), 'updater.log');
  const customLogger = {
    info(msg: any) {
      try { fs.appendFileSync(logFilePath, `[INFO] ${new Date().toISOString()} - ${msg}\n`); } catch {}
    },
    warn(msg: any) {
      try { fs.appendFileSync(logFilePath, `[WARN] ${new Date().toISOString()} - ${msg}\n`); } catch {}
    },
    error(msg: any) {
      try { fs.appendFileSync(logFilePath, `[ERROR] ${new Date().toISOString()} - ${msg}\n`); } catch {}
    }
  };
  autoUpdater.logger = customLogger;

  // Keep electron-updater's default verification. SHA-512 is checked against the
  // release manifest. Authenticode verification runs when a publisherName is
  // configured by a signed build; unsigned builds do not provide publisher identity.

  autoUpdater.on('checking-for-update', () => {
    customLogger.info('Checking for update...');
    updateEvent({type:'checking'});
  });

  autoUpdater.on('update-available', (info) => {
    customLogger.info(`Update available: ${info.version}`);
    updateEvent({type:'available',version:info.version});
    broadcast(IPC.updateAvailable, info.version);
  });

  autoUpdater.on('update-not-available', () => {
    customLogger.info('Update not available.');
    updateEvent({type:'current'});
  });

  autoUpdater.on('error', (err) => {
    customLogger.error(`Error checking for update: ${err.message || String(err)}`);
    updateEvent({type:'error',message:err.message || String(err)});
    broadcast(IPC.updateError, err.message || String(err));
  });

  autoUpdater.on('update-downloaded', (info) => {
    customLogger.info(`Update downloaded: ${info.version}`);
    updateEvent({type:'downloaded',version:info.version});
    broadcast(IPC.updateDownloaded, info.version);

    // Native OS Notification
    try {
      const notification = new Notification({
        title: 'Software Update Ready',
        body: `Version v${info.version} has been successfully downloaded. Click to restart and update.`,
      });
      notification.on('click', () => {
        if (mainWindow) {
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.restore();
          mainWindow.focus();
        }
        autoUpdater.quitAndInstall();
      });
      notification.show();
    } catch (err) {
      customLogger.error(`Failed to show native notification: ${err}`);
    }
  });

  autoUpdater.on('download-progress',info=>updateEvent({type:'progress',percent:info.percent}));
  void checkSoftwareUpdates();
  setInterval(() => {
    void checkSoftwareUpdates();
  }, 4 * 60 * 60 * 1000);
}

import { runTwitterScrape } from './scraper/twitter';



function setAutoStart(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath('exe'),
    args: ['--hidden'],
  });
}

function getAutoStart(): boolean {
  const settings = app.getLoginItemSettings({
    path: app.getPath('exe'),
    args: ['--hidden'],
  });
  return settings.openAtLogin;
}

async function triggerNewsScrape(): Promise<void> {
  const settings = getSettings();
  await runTwitterScrape({ headless: settings.headless });
}

function cleanupTestTask(): void {
  const taskName = 'InsiderWhaleTerminal_Test';
  execFile('schtasks', ['/delete', '/tn', taskName, '/f'], (err, stdout, stderr) => {
    if (err) {
      // Ignore errors if the task does not exist
      return;
    }
    console.log(`[cleanup-test-task] Successfully deleted scheduled test task: ${stdout}`);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// IPC handlers
// ──────────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!trustedRenderer(event, mainWindow?.webContents ?? null, rendererEntry)) throw new Error('Untrusted IPC sender');
    if ([IPC.authStartLogin,IPC.authSaveLogin,IPC.authCancelLogin,IPC.authLogout].includes(channel as typeof IPC.authStartLogin)) requirePlatform(args[0]);
    return listener(event, ...args);
  });
  handle(IPC.scraperStart, () => triggerScrape());
  handle(IPC.analysisAnalyze, async (_e, ticker: unknown) => {
    const { analyzeStock } = await import('./analysis');
    return analyzeStock(ticker);
  });
  handle(IPC.analysisSearch, async (_e, query: unknown) => {
    const { searchStocks } = await import('./marketData');
    return searchStocks(query);
  });
  handle(IPC.scraperStatus, () => getScrapeStatus());

  handle(IPC.signalsGetAll, () => getLatestSignals());
  handle(IPC.signalsGetByTicker, (_e, ticker: string) => getSignalByTicker(ticker));
  handle(IPC.signalsGetHistory, (_e, ticker: string) => getSignalHistory(ticker));
  handle(IPC.signalsGetFiltered, (_e, filter: SignalFilter) => getFilteredSignals(filter));
  handle(IPC.signalsGetPerformance, (_e, ticker: string) => getSignalPerformance(ticker));
  handle(IPC.signalsExportCsv, () => exportSignalsCsv());

  handle(IPC.vixGetCurrent, () => getCachedVix());
  handle(IPC.insiderGetTrackRecord, (_e, name: string, role?: string, url?: string) =>
    fetchTrackRecord(name, role, url),
  );

  handle(IPC.watchlistGetAll, () => getWatchlist());
  handle(IPC.watchlistAdd, (_e, ticker: string, notes?: string) => addToWatchlist(ticker, notes));
  handle(IPC.watchlistRemove, (_e, ticker: string) => removeFromWatchlist(ticker));

  handle(IPC.settingsGet, () => getSettings());
  handle(IPC.settingsSet, (_e, partial: Partial<AppSettings>) => {
    const merged = setSettings(partial);
    // Re-arm the scheduler whenever schedule-related settings change.
    configureScheduler(
      merged,
      () => { void triggerScrape(); },
      () => { void triggerNewsScrape(); }
    );
    return merged;
  });

  handle(IPC.earningsFetch, (_e, ticker: string) => fetchEarningsForTicker(ticker));

  // Platform logins (authenticated scraping)
  handle(IPC.authStatus, () => authStatus());
  handle(IPC.authStartLogin, (_e, platform: string) => startLogin(platform));
  handle(IPC.authSaveLogin, (_e, platform: string) => saveLogin(platform));
  handle(IPC.authCancelLogin, (_e, platform: string) => cancelLogin(platform));
  handle(IPC.authLogout, (_e, platform: string) => logout(platform));

  handle(IPC.historyGetScrapeLogs, () => getScrapeLogs());
  handle(IPC.performanceGetLatest, () => getLatestBacktestRun());
  handle(IPC.shadowGetConfig, () => getShadowScoringConfig());
  handle(IPC.shadowSetConfig, (_e, config: Partial<ScoringConfig> | null) =>
    setShadowScoringConfig(config),
  );
  handle(IPC.performanceRecompute, async () => {
    const report = await computePerformanceReport();
    insertBacktestRun(report);
    return report;
  });
  // Testing portfolio. Sync/rebuild talk to Yahoo, so they are async; getState
  // is a pure read and stays cheap enough to call on every tab switch.
  handle(IPC.portfolioGetState, () => getPortfolioState());
  handle(IPC.backtestGetState, () => getBacktestState());
  handle(IPC.backtestRetry, (_e, key: string) => retryBacktest(key));
  handle(IPC.portfolioSync, async () => {
    await syncPortfolio();
    return getPortfolioState();
  });
  handle(IPC.portfolioRebuild, async () => {
    await rebuildPortfolio();
    return getPortfolioState();
  });
  handle(IPC.portfolioSetConfig, async (_e, config: Partial<PortfolioConfig>) => {
    await updatePortfolioConfig(config);
    return getPortfolioState();
  });

  handle(IPC.alertsGetRules, () => getAlertRules());
  handle(IPC.alertsAddRule, (_e, rule: AlertRule) => {
    addAlertRule(rule);
    return getAlertRules();
  });
  handle(IPC.alertsRemoveRule, (_e, id: number) => {
    deleteAlertRule(id);
    return getAlertRules();
  });
  handle(IPC.alertsToggleRule, (_e, id: number, enabled: boolean) => {
    setAlertRuleEnabled(id, enabled);
    return getAlertRules();
  });
  handle(IPC.appGetLastScrape, () => getLastScrapeTime());
  handle(IPC.appGetVersion, () => app.getVersion());
  handle(IPC.newsGetAll, () => getNewsItems());
  handle(IPC.newsGetForTicker, (_e, ticker: string) => getNewsForTicker(ticker));
  handle(IPC.newsScrapeNow, () => triggerNewsScrape());
  handle(IPC.appSetAutoStart, (_e, enabled: boolean) => setAutoStart(enabled));
  handle(IPC.appGetAutoStart, () => getAutoStart());
  handle(IPC.updateQuitAndInstall, () => {
    if(softwareUpdate.status!=='downloaded')throw new Error('No downloaded software update is ready.');
    console.log('[updater] Quitting and installing update...');
    autoUpdater.quitAndInstall();
  });
  handle(IPC.updateGetStatus, () => softwareUpdate);
  handle(IPC.updateCheck, () => checkSoftwareUpdates());

  handle(IPC.dbClear, () => {
    clearDatabase();
    broadcast(IPC.appSignalsUpdated, getLatestSignals());
  });

  handle(IPC.appTestSchedule, async () => {
    const appPath = app.getPath('exe');
    const now = new Date();
    // Add 1 minute, or if seconds >= 45, add 2 minutes to be safe.
    const target = new Date(now.getTime() + (now.getSeconds() >= 45 ? 120 : 60) * 1000);
    const hours = String(target.getHours()).padStart(2, '0');
    const minutes = String(target.getMinutes()).padStart(2, '0');
    const hhmm = `${hours}:${minutes}`;

    const taskName = 'InsiderWhaleTerminal_Test';
    const args = [
      '/create',
      '/tn',
      taskName,
      '/tr',
      `"${appPath}" --scheduled-scrape`,
      '/sc',
      'once',
      '/st',
      hhmm,
      '/f'
    ];

    console.log(`[test-schedule] Scheduling task with execFile: schtasks ${args.join(' ')}`);

    return new Promise<void>((resolve, reject) => {
      execFile('schtasks', args, (error, stdout, stderr) => {
        if (error) {
          console.error(`[test-schedule] Failed to create scheduled task: ${error.message || stderr}`);
          reject(error);
          return;
        }
        console.log(`[test-schedule] Task scheduled successfully for ${hhmm}: ${stdout}`);

        // Terminate the app after 1 second so that Task Scheduler can run it
        setTimeout(() => {
          console.log('[test-schedule] Quitting app for scheduled test task...');
          app.quit();
        }, 1000);

        resolve();
      });
    });
  });

  handle(IPC.appSetTheme, (_e, theme: string) => {
    if (mainWindow) {
      const color = theme === 'dark' ? '#050507' : '#f5f5f7';
      mainWindow.setBackgroundColor(color);
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────────────────────────────────

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    if (commandLine.includes('--scheduled-scrape')) {
      console.log('[scheduler] Received scheduled background scrape request from second instance.');
      void triggerScrape().then(() => syncTaskScheduler(getSettings())).catch(console.error);
      return;
    }

    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (app.isPackaged) {
      void checkSoftwareUpdates();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const dbPath = path.join(app.getPath('userData'), 'insider-tracker.db');
    initDatabase(dbPath);

    // Seed de-dupe from all active (dashboard) highs so a restart doesn't re-toast.
    const settings = getSettings();
    seedNotified(
      getLatestSignals()
        .filter((s) => s.score >= settings.notificationThreshold)
        .map((s) => s.ticker),
    );

    // Ensure registry/startup entry from previous versions is cleanly removed
    try {
      app.setLoginItemSettings({
        openAtLogin: false,
        path: app.getPath('exe'),
        args: ['--hidden'],
      });
    } catch {}

    registerIpc();

    const isScheduledScrape = process.argv.includes('--scheduled-scrape');

    if (isScheduledScrape) {
      console.log('[scheduler] Starting scheduled background scrape...');
      cleanupTestTask();
      // Warm VIX (await the value) before scoring so background scrapes match
      // interactive ones — getCachedVix() is otherwise still null at scrape time.
      fetchVix()
        .catch(() => undefined)
        .then(() => triggerScrape())
        // Replenish the rolling UTC trigger horizon; each date already includes its own NY DST offset.
        .then(() => syncTaskScheduler(getSettings()).catch(() => undefined))
        .then(() => {
          console.log('[scheduler] Scheduled background scrape completed.');
          stopScheduler();
          stopVixPolling();
          closeDatabase();
          app.exit(0);
        })
        .catch((err) => {
          console.error('[scheduler] Scheduled background scrape failed:', err);
          stopScheduler();
          stopVixPolling();
          closeDatabase();
          app.exit(1);
        });
    } else {
      cleanupTestTask();
      createWindow();
      initAutoUpdater();

      // Global shortcut to toggle DevTools at any time (windowed mode only).
      globalShortcut.register('F12', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.toggleDevTools();
      });

      // Feature 8 — keep VIX warm (fetch now + every 15 min).
      startVixPolling();

      configureScheduler(
        settings,
        () => { void triggerScrape(); },
        () => { void triggerNewsScrape(); }
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && !isScheduledScrape) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      stopScheduler();
      stopVixPolling();
      closeDatabase();
      app.quit();
    }
  });

  app.on('before-quit', () => {
    (app as any).isQuitting = true;
    globalShortcut.unregisterAll();
    stopScheduler();
    stopVixPolling();
    void closeAllLogins();
    closeDatabase();
  });
}
