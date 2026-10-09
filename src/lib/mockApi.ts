import { DEFAULT_SETTINGS, filterSignals, LOGIN_PLATFORMS, type InsiderTrackerAPI, type AuthStatus } from '@/types';
import { sampleSignals, sampleWatchlist, sampleLogs, sampleTrackRecord, samplePortfolio } from './sampleData';
import { requestStockAnalysis } from './analysisApi';
import { catalogueAnalysis } from './analysisCatalogueApi';

const mockAuthStatus = (): AuthStatus =>
  Object.fromEntries(LOGIN_PLATFORMS.map((p) => [p.key, { loggedIn: false, savedAt: null }]));

/**
 * No-op API used when the renderer runs in a plain browser (e.g. `vite preview`)
 * outside the Electron shell. Serves sample data so the UI never crashes.
 * Moved out of `ipc.ts` (v1.1.2) so the web API can reuse it as a base.
 */
export const mockApi: InsiderTrackerAPI = {
  analysis: { analyze: requestStockAnalysis, search: catalogueAnalysis.search },
  scraper: {
    start: async () => ({
      status: 'failed',
      signalsFound: 0,
      signals: [],
      sourcesScraped: [],
      errors: [{ source: 'mock', message: 'Not running inside Electron.' }],
      newHighConviction: [],
      newCombos: [],
      scoreSurges: [],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }),
    getStatus: async () => ({
      running: false,
      phase: 'idle',
      completedSources: [],
      totalSources: 0,
      signalsFound: 0,
    }),
    onStatus: () => () => undefined,
  },
  signals: {
    getAll: async () => sampleSignals,
    getByTicker: async (ticker: string) => sampleSignals.find((s) => s.ticker === ticker.toUpperCase()) ?? null,
    getHistory: async (ticker: string) => {
      const base = sampleSignals.find((s) => s.ticker === ticker.toUpperCase());
      if (!base) return [];
      return [0.7, 0.82, 0.95, 1].map((f, i) => ({
        ...base,
        score: Math.round(base.score * f * 10) / 10,
        scrapedAt: new Date(Date.now() - (3 - i) * 86400000).toISOString(),
      }));
    },
    getFiltered: async (filter) => filterSignals(sampleSignals, filter),
    getPerformance: async (ticker: string) => ({ ticker: ticker.toUpperCase(), sinceDate: new Date().toISOString().slice(0, 10) }),
    exportCsv: async () => ({ ok: false, error: 'CSV export is only available in the desktop app.' }),
  },
  vix: {
    getCurrent: async () => ({ value: 22.4, level: 'normal', timestamp: new Date().toISOString() }),
  },
  insider: {
    getTrackRecord: async (name: string) => sampleTrackRecord(name),
  },
  auth: {
    status: async () => mockAuthStatus(),
    startLogin: async () => ({ ok: false, message: 'Login is only available in the desktop app.' }),
    saveLogin: async () => ({ ok: false, message: 'Login is only available in the desktop app.' }),
    cancelLogin: async () => undefined,
    logout: async () => mockAuthStatus(),
  },
  watchlist: {
    add: async () => sampleWatchlist,
    remove: async () => sampleWatchlist,
    getAll: async () => sampleWatchlist,
  },
  settings: {
    get: async () => DEFAULT_SETTINGS,
    set: async () => DEFAULT_SETTINGS,
  },
  earnings: {
    fetch: async () => ({}),
  },
  history: {
    getScrapeLogs: async () => sampleLogs,
  },
  alerts: {
    getRules: async () => [],
    addRule: async () => [],
    removeRule: async () => [],
    toggleRule: async () => [],
  },
  shadow: {
    get: async () => null,
    set: async () => null,
  },
  portfolio: {
    getState: async () => samplePortfolio(),
    sync: async () => samplePortfolio(),
    rebuild: async () => samplePortfolio(),
    setConfig: async () => samplePortfolio(),
  },
  backtest: {
    getState: async () => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), records: [], readOnly: true }),
    retry: async () => { throw new Error('In der Vorschau gibt es keine abgeschlossenen Käufe.'); },
  },
  performance: {
    getLatest: async () => null,
    recompute: async () => ({
      ranAt: new Date().toISOString(),
      fromDate: null,
      toDate: null,
      nObservations: 0,
      tiers: [],
      buckets: [],
      ic10: null,
      note: 'Performance analysis is only available in the desktop app.',
    }),
  },
  db: {
    clear: async () => undefined,
  },
  news: {
    getAll: async () => [],
    getForTicker: async () => [],
    scrapeNow: async () => undefined,
    setAutoStart: async () => undefined,
    getAutoStart: async () => false,
  },
  app: {
    getVersion: async () => '1.0.0',
    getLastScrape: async () => new Date(Date.now() - 3500_000).toISOString(),
    onSignalsUpdated: () => () => undefined,
    onOpenTicker: () => () => undefined,
    onUpdateAvailable: () => () => undefined,
    onUpdateDownloaded: () => () => undefined,
    onUpdateError: () => () => undefined,
    quitAndInstall: async () => undefined,
    getUpdateStatus: async () => ({ status: 'idle', version: '' }),
    checkForSoftwareUpdates: async () => ({ status: 'current', version: '' }),
    testSchedule: async () => undefined,
    setTheme: async () => undefined,
  },
};
