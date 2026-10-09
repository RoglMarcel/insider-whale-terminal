import { create } from 'zustand';
import type {
  Signal,
  WatchlistItem,
  AppSettings,
  ScrapeStatus,
  ScrapeLogEntry,
  SignalFilter,
  VixQuote,
  InsiderTrackRecord,
  AuthStatus,
} from '@/types';
import { DEFAULT_SETTINGS, DEFAULT_FILTER } from '@/types';
import { api } from '@/lib/ipc';
import { type Lang, initialLanguage, persistLanguage } from '@/lib/i18n';

export type View = 'dashboard' | 'analysis' | 'portfolio' | 'backtest' | 'watchlist' | 'history' | 'news' | 'settings';
export type Theme = 'light' | 'dark';

const FILTER_KEY = 'signalFilter';

function loadFilter(): SignalFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) return { ...DEFAULT_FILTER, ...(JSON.parse(raw) as Partial<SignalFilter>) };
  } catch {
    /* ignore */
  }
  return DEFAULT_FILTER;
}

function saveFilter(filter: SignalFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
  } catch {
    /* ignore */
  }
}

let vixTimer: ReturnType<typeof setInterval> | null = null;
// Synchronous guard so two near-simultaneous init() callers (e.g. React 18
// StrictMode double-invoke) can't both pass the async `initialized` check and
// register duplicate IPC listeners.
let initStarted = false;

const IDLE_STATUS: ScrapeStatus = {
  running: false,
  phase: 'idle',
  completedSources: [],
  totalSources: 0,
  signalsFound: 0,
};

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* ignore */
  }
}

/**
 * The light/dark switch was removed in favour of the language switch, so the
 * app is dark-only. `theme` stays in the store because the TradingView embed
 * takes it as a parameter — it is simply no longer variable.
 */
function initialTheme(): Theme {
  return 'dark';
}

interface StoreState {
  // ── Data ──
  signals: Signal[];
  watchlist: WatchlistItem[];
  scrapeLogs: ScrapeLogEntry[];
  settings: AppSettings;
  lastScrapeAt: string | null;

  // ── UI ──
  theme: Theme;
  language: Lang;
  view: View;
  selectedTicker: string | null;
  chartOnly: boolean;
  scrapeStatus: ScrapeStatus;
  initialized: boolean;
  filter: SignalFilter;
  vix: VixQuote | null;
  authStatus: AuthStatus;

  // ── Actions ──
  init: () => Promise<void>;
  setView: (view: View) => void;
  setLanguage: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  openSignal: (ticker: string, chartOnly?: boolean) => void;
  closeSignal: () => void;
  setFilter: (partial: Partial<SignalFilter>) => void;
  refresh: () => Promise<void>;
  loadSignals: () => Promise<void>;
  loadWatchlist: () => Promise<void>;
  loadLogs: () => Promise<void>;
  loadVix: () => Promise<void>;
  addWatch: (ticker: string, notes?: string) => Promise<void>;
  removeWatch: (ticker: string) => Promise<void>;
  saveSettings: (partial: Partial<AppSettings>) => Promise<void>;
  clearDatabase: () => Promise<void>;
  fetchTrackRecord: (name: string, role?: string, url?: string) => Promise<InsiderTrackRecord | null>;
  loadAuthStatus: () => Promise<void>;
  startLogin: (platform: string) => Promise<{ ok: boolean; message?: string }>;
  saveLogin: (platform: string) => Promise<{ ok: boolean; message?: string }>;
  cancelLogin: (platform: string) => Promise<void>;
  logoutPlatform: (platform: string) => Promise<void>;
}

export const useStore = create<StoreState>((set, get) => ({
  signals: [],
  watchlist: [],
  scrapeLogs: [],
  settings: DEFAULT_SETTINGS,
  lastScrapeAt: null,

  theme: initialTheme(),
  language: initialLanguage(),
  view: 'dashboard',
  selectedTicker: null,
  chartOnly: false,
  scrapeStatus: IDLE_STATUS,
  initialized: false,
  filter: loadFilter(),
  vix: null,
  authStatus: {},

  init: async () => {
    if (get().initialized || initStarted) return;
    initStarted = true;

    const theme = initialTheme();
    applyTheme(theme);
    void api.app.setTheme(theme);
    persistLanguage(get().language);

    // Live subscriptions from the main process.
    api.scraper.onStatus((status) => set({ scrapeStatus: status }));
    api.app.onSignalsUpdated(async (signals) => {
      set({ signals });
      const [lastScrapeAt, scrapeLogs, watchlist] = await Promise.all([
        api.app.getLastScrape(),
        api.history.getScrapeLogs(),
        api.watchlist.getAll(),
      ]);
      set({ lastScrapeAt, scrapeLogs, watchlist });
    });
    api.app.onOpenTicker((ticker) => set({ selectedTicker: ticker }));

    const [settings, signals, watchlist, lastScrapeAt, scrapeLogs, scrapeStatus] = await Promise.all([
      api.settings.get(),
      api.signals.getAll(),
      api.watchlist.getAll(),
      api.app.getLastScrape(),
      api.history.getScrapeLogs(),
      api.scraper.getStatus(),
    ]);

    set({
      settings,
      signals,
      watchlist,
      lastScrapeAt,
      scrapeLogs,
      scrapeStatus: await api.scraper.getStatus(),
      theme,
      initialized: true,
    });

    // Feature 8 — VIX now + refresh every 5 minutes.
    void get().loadVix();
    if (!vixTimer) vixTimer = setInterval(() => void get().loadVix(), 5 * 60 * 1000);

    // Platform login status.
    void get().loadAuthStatus();
  },

  setView: (view) => set({ view }),

  setFilter: (partial) => {
    const filter = { ...get().filter, ...partial };
    saveFilter(filter);
    set({ filter });
  },

  loadVix: async () => {
    try {
      const vix = await api.vix.getCurrent();
      set({ vix });
    } catch {
      /* ignore */
    }
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
    void api.app.setTheme(theme);
  },

  setLanguage: (lang) => {
    persistLanguage(lang);
    set({ language: lang });
  },

  openSignal: (ticker, chartOnly) => set({ selectedTicker: ticker, chartOnly: !!chartOnly }),
  closeSignal: () => set({ selectedTicker: null, chartOnly: false }),

  refresh: async () => {
    if (get().scrapeStatus.running) return;
    set({ scrapeStatus: { ...get().scrapeStatus, running: true, phase: 'Starting…' } });
    try {
      await api.scraper.start();
    } finally {
      // Always sync status after scrape so a missed IPC event can't leave
      // running=true / "12/12" stuck in the header indefinitely.
      try {
        const status = await api.scraper.getStatus();
        set({
          scrapeStatus: {
            ...status,
            running: false,
            phase: status.phase === 'Done' || status.running === false ? 'idle' : status.phase,
            completedSources: [],
            totalSources: 0,
          },
        });
      } catch {
        set({ scrapeStatus: { ...IDLE_STATUS } });
      }
      await get().loadSignals();
      const lastScrapeAt = await api.app.getLastScrape();
      set({ lastScrapeAt });
      await Promise.all([get().loadLogs(), get().loadWatchlist()]);
    }
  },

  loadSignals: async () => {
    const signals = await api.signals.getAll();
    set({ signals });
  },

  loadWatchlist: async () => {
    const watchlist = await api.watchlist.getAll();
    set({ watchlist });
  },

  loadLogs: async () => {
    const scrapeLogs = await api.history.getScrapeLogs();
    set({ scrapeLogs });
  },

  addWatch: async (ticker, notes) => {
    const watchlist = await api.watchlist.add(ticker, notes);
    set({ watchlist });
  },

  removeWatch: async (ticker) => {
    const watchlist = await api.watchlist.remove(ticker);
    set({ watchlist });
  },

  saveSettings: async (partial) => {
    const settings = await api.settings.set(partial);
    set({ settings });
  },

  clearDatabase: async () => {
    await api.db.clear();
    await Promise.all([get().loadSignals(), get().loadLogs(), get().loadWatchlist()]);
    set({ lastScrapeAt: await api.app.getLastScrape() });
  },


  fetchTrackRecord: (name, role, url) => api.insider.getTrackRecord(name, role, url),

  loadAuthStatus: async () => {
    try {
      const authStatus = await api.auth.status();
      set({ authStatus });
    } catch {
      /* ignore */
    }
  },

  startLogin: (platform) => api.auth.startLogin(platform),

  saveLogin: async (platform) => {
    const res = await api.auth.saveLogin(platform);
    if (res.ok) await get().loadAuthStatus();
    return res;
  },

  cancelLogin: (platform) => api.auth.cancelLogin(platform),

  logoutPlatform: async (platform) => {
    const authStatus = await api.auth.logout(platform);
    set({ authStatus });
  },
}));
