import { contextBridge, ipcRenderer } from 'electron';
import type {
  InsiderTrackerAPI,
  PortfolioConfig,
  ScrapeStatus,
  Signal,
} from '../src/types';
import { IPC } from './ipc-channels';

/**
 * The renderer never touches ipcRenderer directly; it only sees `window.api`.
 */

const api: InsiderTrackerAPI = {
  analysis: { analyze: ticker => ipcRenderer.invoke(IPC.analysisAnalyze, ticker), search: query => ipcRenderer.invoke(IPC.analysisSearch, query) },
  scraper: {
    start: () => ipcRenderer.invoke(IPC.scraperStart),
    getStatus: () => ipcRenderer.invoke(IPC.scraperStatus),
    onStatus: (cb: (status: ScrapeStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: ScrapeStatus) => cb(status);
      ipcRenderer.on(IPC.scraperStatusUpdate, listener);
      return () => ipcRenderer.removeListener(IPC.scraperStatusUpdate, listener);
    },
  },
  signals: {
    getAll: () => ipcRenderer.invoke(IPC.signalsGetAll),
    getByTicker: (ticker: string) => ipcRenderer.invoke(IPC.signalsGetByTicker, ticker),
    getHistory: (ticker: string) => ipcRenderer.invoke(IPC.signalsGetHistory, ticker),
    getFiltered: (filter) => ipcRenderer.invoke(IPC.signalsGetFiltered, filter),
    getPerformance: (ticker: string) => ipcRenderer.invoke(IPC.signalsGetPerformance, ticker),
    exportCsv: () => ipcRenderer.invoke(IPC.signalsExportCsv),
  },
  vix: {
    getCurrent: () => ipcRenderer.invoke(IPC.vixGetCurrent),
  },
  insider: {
    getTrackRecord: (name: string, role?: string, url?: string) =>
      ipcRenderer.invoke(IPC.insiderGetTrackRecord, name, role, url),
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus),
    startLogin: (platform: string) => ipcRenderer.invoke(IPC.authStartLogin, platform),
    saveLogin: (platform: string) => ipcRenderer.invoke(IPC.authSaveLogin, platform),
    cancelLogin: (platform: string) => ipcRenderer.invoke(IPC.authCancelLogin, platform),
    logout: (platform: string) => ipcRenderer.invoke(IPC.authLogout, platform),
  },
  watchlist: {
    add: (ticker: string, notes?: string) => ipcRenderer.invoke(IPC.watchlistAdd, ticker, notes),
    remove: (ticker: string) => ipcRenderer.invoke(IPC.watchlistRemove, ticker),
    getAll: () => ipcRenderer.invoke(IPC.watchlistGetAll),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (settings) => ipcRenderer.invoke(IPC.settingsSet, settings),
  },
  earnings: {
    fetch: (ticker: string) => ipcRenderer.invoke(IPC.earningsFetch, ticker),
  },
  history: {
    getScrapeLogs: () => ipcRenderer.invoke(IPC.historyGetScrapeLogs),
  },
  performance: {
    getLatest: () => ipcRenderer.invoke(IPC.performanceGetLatest),
    recompute: () => ipcRenderer.invoke(IPC.performanceRecompute),
  },
  portfolio: {
    getState: () => ipcRenderer.invoke(IPC.portfolioGetState),
    sync: () => ipcRenderer.invoke(IPC.portfolioSync),
    rebuild: () => ipcRenderer.invoke(IPC.portfolioRebuild),
    setConfig: (config: Partial<PortfolioConfig>) => ipcRenderer.invoke(IPC.portfolioSetConfig, config),
  },
  shadow: {
    get: () => ipcRenderer.invoke(IPC.shadowGetConfig),
    set: (config) => ipcRenderer.invoke(IPC.shadowSetConfig, config),
  },
  alerts: {
    getRules: () => ipcRenderer.invoke(IPC.alertsGetRules),
    addRule: (rule) => ipcRenderer.invoke(IPC.alertsAddRule, rule),
    removeRule: (id: number) => ipcRenderer.invoke(IPC.alertsRemoveRule, id),
    toggleRule: (id: number, enabled: boolean) => ipcRenderer.invoke(IPC.alertsToggleRule, id, enabled),
  },
  db: {
    clear: () => ipcRenderer.invoke(IPC.dbClear),
  },
  news: {
    getAll: () => ipcRenderer.invoke(IPC.newsGetAll),
    getForTicker: (ticker: string) => ipcRenderer.invoke(IPC.newsGetForTicker, ticker),
    scrapeNow: () => ipcRenderer.invoke(IPC.newsScrapeNow),
    setAutoStart: (enabled) => ipcRenderer.invoke(IPC.appSetAutoStart, enabled),
    getAutoStart: () => ipcRenderer.invoke(IPC.appGetAutoStart),
  },
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion),
    getLastScrape: () => ipcRenderer.invoke(IPC.appGetLastScrape),
    onSignalsUpdated: (cb: (signals: Signal[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, signals: Signal[]) => cb(signals);
      ipcRenderer.on(IPC.appSignalsUpdated, listener);
      return () => ipcRenderer.removeListener(IPC.appSignalsUpdated, listener);
    },
    onOpenTicker: (cb: (ticker: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ticker: string) => cb(ticker);
      ipcRenderer.on(IPC.appOpenTicker, listener);
      return () => ipcRenderer.removeListener(IPC.appOpenTicker, listener);
    },
    onUpdateAvailable: (cb: (version: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, version: string) => cb(version);
      ipcRenderer.on(IPC.updateAvailable, listener);
      return () => ipcRenderer.removeListener(IPC.updateAvailable, listener);
    },
    onUpdateDownloaded: (cb: (version: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, version: string) => cb(version);
      ipcRenderer.on(IPC.updateDownloaded, listener);
      return () => ipcRenderer.removeListener(IPC.updateDownloaded, listener);
    },
    onUpdateError: (cb: (err: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, err: string) => cb(err);
      ipcRenderer.on(IPC.updateError, listener);
      return () => ipcRenderer.removeListener(IPC.updateError, listener);
    },
    quitAndInstall: () => ipcRenderer.invoke(IPC.updateQuitAndInstall),
    getUpdateStatus: () => ipcRenderer.invoke(IPC.updateGetStatus),
    checkForSoftwareUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
    testSchedule: () => ipcRenderer.invoke(IPC.appTestSchedule),
    setTheme: (theme: string) => ipcRenderer.invoke(IPC.appSetTheme, theme),
  },
};

contextBridge.exposeInMainWorld('api', api);
