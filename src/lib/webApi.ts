import {
  filterSignals,
  type InsiderTrackerAPI,
  type PortfolioState,
  type ScrapeLogEntry,
  type Signal,
  type ScrapeStatus,
  type VixQuote,
  type WatchlistItem,
} from '@/types';
import { emptyPortfolioState } from './portfolio-rules';
import { mockApi } from './mockApi';
import { catalogueAnalysis } from './analysisCatalogueApi';
import type { BacktestState } from '../types/backtest';
import { mergeLocalBacktest, retryLocalBacktest } from './backtest-web';

/**
 * Web API (v1.1.2) — the "read-only" InsiderTrackerAPI for the hosted website.
 *
 * The scrape runs on GitHub Actions (`scripts/scrape-web.ts`) and writes static
 * JSON into `public/data/`. Here we read that JSON instead of talking to an
 * Electron main process. Everything the browser genuinely cannot do (trigger a
 * scrape, log in, export CSV) falls back to `mockApi`. The watchlist is kept
 * per-device in `localStorage` — free, no backend.
 */

const DATA_BASE = `${import.meta.env.BASE_URL ?? '/'}data/`;

interface Meta {
  generatedAt?: string;
  version?: string;
  vix?: VixQuote | null;
  /** Recent scrape sessions, published by the runner (see scripts/scrape-web.ts). */
  runs?: ScrapeLogEntry[];
}

let signalsCache: { at: number; data: Signal[] } | null = null;
const SIGNALS_TTL_MS = 60_000;

const readErrors = new Map<string, string>();
const statusListeners = new Set<(status: ScrapeStatus) => void>();
function readStatus(): ScrapeStatus {
  const error = [...readErrors.values()].join(' | ') || undefined;
  return { running: false, phase: error ? 'Data fetch failed' : 'idle', completedSources: [], totalSources: 0, signalsFound: signalsCache?.data.length ?? 0, error };
}
function publishReadStatus(): void { for (const listener of statusListeners) listener(readStatus()); }
async function loadJson<T>(file: string, fallback: T, optional = false): Promise<T> {
  try {
    const res = await fetch(`${DATA_BASE}${file}`, { cache: 'no-store' });
    if (optional && res.status === 404) { readErrors.delete(file); publishReadStatus(); return fallback; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (Array.isArray(fallback) ? !Array.isArray(data) : !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid data shape');
    if (file === 'signals.json' && !(data as unknown[]).every(row => row && typeof row === 'object' && typeof (row as Signal).ticker === 'string' && Number.isFinite((row as Signal).score))) throw new Error('Invalid signal data');
    readErrors.delete(file); publishReadStatus();
    return data as T;
  } catch (error) {
    readErrors.set(file, `${file}: ${error instanceof Error ? error.message : 'Fetch failed'}. Last available data may be outdated.`);
    publishReadStatus();
    throw error;
  }
}

async function loadSignals(force = false): Promise<Signal[]> {
  if (!force && signalsCache && Date.now() - signalsCache.at < SIGNALS_TTL_MS) {
    return signalsCache.data;
  }
  try {
    const data = await loadJson<Signal[]>('signals.json', []);
    signalsCache = { at: Date.now(), data };
    return data;
  } catch { return signalsCache?.data ?? []; } // Never refresh the cache timestamp on failure.
}

const loadMeta = () => loadJson<Meta>('meta.json', {}).catch(() => ({} as Meta));
const loadBacktest = (): Promise<BacktestState> => loadJson<BacktestState>('backtest.json', { schemaVersion: 1, generatedAt: '', records: [], readOnly: true });

/** Published portfolio state; an absent file means "not built yet", not an error. */
const loadPortfolio = (): Promise<PortfolioState> =>
  loadJson<PortfolioState>(
    'portfolio.json',
    emptyPortfolioState('The testing portfolio has not been published yet — it is built by the scheduled run.'),
    true,
  ).catch(() => emptyPortfolioState('Portfolio data could not be loaded. Please retry.')).then((s) => ({ ...s, meta: { ...s.meta, readOnly: true } }));

// ── Per-device watchlist (localStorage) ──
const WL_KEY = 'iwt.watchlist';

function readWatchlist(): WatchlistItem[] {
  try {
    const raw = localStorage.getItem(WL_KEY);
    return raw ? (JSON.parse(raw) as WatchlistItem[]) : [];
  } catch {
    return [];
  }
}

function writeWatchlist(items: WatchlistItem[]): WatchlistItem[] {
  try {
    localStorage.setItem(WL_KEY, JSON.stringify(items));
  } catch {
    /* private mode / quota — best-effort */
  }
  return items;
}

async function watchlistJoined(): Promise<WatchlistItem[]> {
  const items = readWatchlist();
  if (!items.length) return items;
  const signals = await loadSignals();
  const byTicker = new Map(signals.map((s) => [s.ticker.toUpperCase(), s]));
  return items.map((it) => ({ ...it, signal: byTicker.get(it.ticker.toUpperCase()) ?? null }));
}

export const webApi: InsiderTrackerAPI = {
  ...mockApi,
  analysis: catalogueAnalysis,
  scraper: {
    ...mockApi.scraper,
    getStatus: async () => readStatus(),
    onStatus: callback => { statusListeners.add(callback); callback(readStatus()); return () => { statusListeners.delete(callback); }; },
  },
  signals: {
    ...mockApi.signals,
    getAll: () => loadSignals(),
    getFiltered: async (filter) => filterSignals(await loadSignals(), filter),
    getByTicker: async (ticker) =>
      (await loadSignals()).find((s) => s.ticker.toUpperCase() === ticker.toUpperCase()) ?? null,
    // Only the latest snapshot is published in v1.1.2 (no cross-run history yet).
    getHistory: async (ticker) => {
      const s = (await loadSignals()).find((x) => x.ticker.toUpperCase() === ticker.toUpperCase());
      return s ? [s] : [];
    },
  },
  vix: {
    getCurrent: async () => (await loadMeta()).vix ?? null,
  },
  watchlist: {
    getAll: () => watchlistJoined(),
    add: async (ticker, notes) => {
      const items = readWatchlist();
      const t = ticker.toUpperCase();
      if (!items.some((i) => i.ticker.toUpperCase() === t)) {
        items.unshift({ ticker: t, addedAt: new Date().toISOString(), notes: notes ?? null });
      }
      writeWatchlist(items);
      return watchlistJoined();
    },
    remove: async (ticker) => {
      const t = ticker.toUpperCase();
      writeWatchlist(readWatchlist().filter((i) => i.ticker.toUpperCase() !== t));
      return watchlistJoined();
    },
  },
  /**
   * The curve is computed by the CI runner (`npm run portfolio:sync`) and
   * published as a static file — a browser can neither reach Yahoo nor write
   * SQLite. The mutating calls therefore return the published state unchanged,
   * and `meta.readOnly` (set by the publisher) tells the UI to hide the
   * controls instead of rendering buttons that do nothing.
   */
  portfolio: {
    getState: () => loadPortfolio(),
    sync: () => loadPortfolio(),
    rebuild: () => loadPortfolio(),
    setConfig: () => loadPortfolio(),
  },
  backtest: {
    getState: async () => mergeLocalBacktest(await loadBacktest()),
    retry: async (key) => retryLocalBacktest(await loadBacktest(), key),
  },
  history: {
    // Real sessions, published in meta.json by the runner — this is what makes the
    // hosted History view (and Source Health, which needs a rolling window across
    // runs) show actual data instead of three empty cards.
    getScrapeLogs: async () => (await loadMeta()).runs ?? [],
  },
  app: {
    ...mockApi.app,
    getVersion: async () => (await loadMeta()).version ?? 'web',
    getLastScrape: async () => (await loadMeta()).generatedAt ?? null,
    // Poll the static JSON so an open tab picks up the next scrape.
    onSignalsUpdated: (cb: (signals: Signal[]) => void) => {
      const id = setInterval(async () => {
        cb(await loadSignals(true));
      }, 60_000);
      return () => clearInterval(id);
    },
  },
};
