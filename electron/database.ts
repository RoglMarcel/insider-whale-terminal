import { utcInstantMs } from '../src/lib/utcDate';
import { BACKTEST_SCHEMA } from './backtestSchema';
import { captureDecision, recordBacktestBook, recordBacktestClosures, analyzePendingBacktests } from './backtest';
import type { DecisionContext } from '../src/types/backtest';
import { sanitizeTradeAmounts } from './scraper/util';
import { tickerIssue, resolvedTicker } from '../src/lib/ticker-quality';
import Database from 'better-sqlite3';
import { tradeFingerprint, selectTradeRevisions } from './tradeRevisions';
import { dedupTrades } from './tradeDedup';
import { admissibleTrade } from '../src/lib/tradeEligibility';
import { eventDate } from '../src/lib/utcDate';
import fs from 'node:fs';
import path from 'node:path';
import {
  type Signal,
  type WatchlistItem,
  type ScrapeLogEntry,
  type AppSettings,
  type ScoreBreakdown,
  type RawInsiderTrade,
  type OptionsActivity,
  type SignalFilter,
  type InsiderTrackRecord,
  type InsiderHistoricalTrade,
  type NewsItem,
  type AlertRule,
  type PerformanceReport,
  type FilingEvent,
  type ScoringConfig,
  type PoliticianTrade,
  type DataQualityReport,
  type PortfolioConfig,
  type PortfolioExperiment,
  type PortfolioCandidate,
  type PortfolioEquityPoint,
  type PortfolioEvent,
  type PortfolioPosition,
  DEFAULT_PORTFOLIO_CONFIG,
  PORTFOLIO_CONFIG_VERSION,
  PORTFOLIO_SUPERSEDED_DEFAULTS,
  DEFAULT_SETTINGS,
  filterSignals,
  isBigPlayer,
  normalizeInsiderName,
  classifyTransaction,
} from '../src/types';

let db: Database.Database | null = null;

/** Keep at most this many dated pre-migration snapshots under userData/backups/. */
const MAX_DB_BACKUPS = 5;

/**
 * Copy the live DB (if it already exists) to backups/insider-tracker-YYYYMMDD.db
 * before migrations. One backup per calendar day; prune older than MAX_DB_BACKUPS.
 * Best-effort — never blocks app start.
 */
function backupDatabaseBeforeMigration(dbPath: string): void {
  try {
    if (!fs.existsSync(dbPath)) return;
    const dir = path.dirname(dbPath);
    const backupsDir = path.join(dir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dest = path.join(backupsDir, `insider-tracker-${day}-consistent.db`);
    if (!fs.existsSync(dest)) {
      const source = new Database(dbPath, { readonly: true, fileMustExist: true });
      const pending = `${dest}.pending`;
      try {
        fs.rmSync(pending, { force: true });
        source.prepare('VACUUM INTO ?').run(pending);
        fs.renameSync(pending, dest);
      } finally { source.close(); }
    }
    const files = fs
      .readdirSync(backupsDir)
      .filter((f) => /^insider-tracker-\d{8}(?:-consistent)?\.db$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_DB_BACKUPS)) {
      try {
        fs.unlinkSync(path.join(backupsDir, f));
        for (const suffix of ['-wal', '-shm']) {
          const p = path.join(backupsDir, f + suffix);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      } catch {
        /* best-effort prune */
      }
    }
  } catch (err) {
    console.error('[database] pre-migration backup failed (continuing):', err);
  }
}

/**
 * Testing-portfolio tables (v1.4.0). Kept as its own constant so SCHEMA and
 * runMigrations() cannot drift apart — the migration path is what runs against
 * the committed history DB, and a table that existed only in SCHEMA would never
 * appear there.
 */
export const PORTFOLIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS ticker_quarantine (
 ticker TEXT PRIMARY KEY, reason TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portfolio_revisions (
 reason TEXT PRIMARY KEY, saved_at TEXT NOT NULL, state_json TEXT NOT NULL
);

-- ── Testing portfolio (v1.4.0) ────────────────────────────────────────────
-- Adjusted-close cache. Every price the portfolio ever uses is read from here,
-- so a Yahoo outage cannot silently reshape the stored curve and two runs on
-- the same day cost one request per ticker, not one per lookup.
CREATE TABLE IF NOT EXISTS price_history (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,            -- YYYY-MM-DD
  adj_close REAL NOT NULL,       -- split- and dividend-adjusted CLOSE only
  fetched_at DATETIME,
  PRIMARY KEY (ticker, date)
);

CREATE TABLE IF NOT EXISTS portfolio_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  signal_id INTEGER,
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,     -- including slippage
  shares REAL NOT NULL,
  cost_basis REAL NOT NULL,
  entry_score REAL NOT NULL,
  target_weight REAL NOT NULL,
  high_water_close REAL,
  exit_date TEXT,
  exit_price REAL,
  exit_reason TEXT,              -- take_profit | stop_loss | trailing | time | data_missing
  realized_pnl REAL,
  spy_entry REAL,
  spy_exit REAL,                 -- benchmark over EXACTLY the same holding period
  UNIQUE (ticker, entry_date)
);

CREATE TABLE IF NOT EXISTS portfolio_equity (
  date TEXT PRIMARY KEY,
  cash REAL NOT NULL,
  spy_cash_value REAL NOT NULL,
  positions_value REAL NOT NULL,
  equity REAL NOT NULL,
  equity_idle REAL NOT NULL,
  benchmark REAL NOT NULL,
  open_positions INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,            -- buy | sell | skipped_no_cash | skipped_cap | data_missing | suspect_price
  ticker TEXT,
  score REAL,
  amount REAL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_pf_positions_ticker ON portfolio_positions(ticker, entry_date);
CREATE INDEX IF NOT EXISTS idx_pf_events_date ON portfolio_events(date);
`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  company_name TEXT,
  score REAL NOT NULL,
  conviction_level TEXT,
  total_dollar_volume REAL,
  insider_count INTEGER,
  top_insider_role TEXT,
  top_insider_name TEXT,
  options_activity TEXT,    -- JSON
  raw_trades TEXT,          -- JSON array
  score_breakdown TEXT,     -- JSON
  scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_urls TEXT,         -- JSON array
  -- Feature 1
  trade_date TEXT,
  filing_date TEXT,
  late_filing INTEGER DEFAULT 0,
  -- Feature 4
  combo_signal INTEGER DEFAULT 0,
  combo_detected_at DATETIME,
  -- Feature 5
  earnings_date TEXT,
  earnings_timing TEXT,
  days_to_earnings INTEGER,
  -- Feature 6 (Tier 3)
  sector TEXT,
  -- Big player computed at insert time (market-cap-aware; static list fallback)
  big_player INTEGER DEFAULT 0,
  -- Score under the shadow (A/B) scoring config, when one is active
  shadow_score REAL,
  -- Sell-side + equity-stats display context (JSON), surfaced on the card/breakdown
  insider_flow TEXT,
  equity_stats TEXT,
  -- Congressional trading leg — score contribution + the trades (JSON)
  politician_score REAL,
  politician_trades TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_scraped_at ON signals(scraped_at);
CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(score);

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT UNIQUE NOT NULL,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS scrape_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at DATETIME,
  finished_at DATETIME,
  sources_scraped TEXT,     -- JSON
  signals_found INTEGER,
  status TEXT,              -- 'success' | 'partial' | 'failed'
  vix_at_scrape REAL,       -- Feature 8
  source_breakdown TEXT     -- JSON breakdown
);


CREATE TABLE IF NOT EXISTS insider_track_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insider_name TEXT NOT NULL,
  insider_role TEXT,
  total_trades INTEGER,
  profitable_3m INTEGER,
  profitable_6m INTEGER,
  accuracy_3m REAL,
  accuracy_6m REAL,
  avg_return_3m REAL,
  recent_trades TEXT,
  last_updated DATETIME,
  error TEXT,
  pattern TEXT              -- 'routine' | 'opportunistic' | NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_itr_name ON insider_track_records(insider_name);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_experiments (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portfolio_experiment_candidates (
  experiment_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  earliest_date TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  PRIMARY KEY (experiment_id, ticker, earliest_date)
);

CREATE TABLE IF NOT EXISTS politician_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician TEXT NOT NULL,
  chamber TEXT CHECK(chamber IN ('House','Senate')) NOT NULL,
  party TEXT,
  committee TEXT,
  ticker TEXT NOT NULL,
  transaction_type TEXT CHECK(transaction_type IN ('buy','sell')) NOT NULL,
  amount_midpoint REAL NOT NULL,
  trade_date TEXT NOT NULL,
  disclosure_date TEXT NOT NULL,
  days_to_disclose INTEGER NOT NULL,
  scraped_at TEXT NOT NULL,
  UNIQUE(politician, ticker, trade_date, transaction_type)
);
CREATE INDEX IF NOT EXISTS idx_politician_trades_ticker ON politician_trades(ticker, trade_date);

CREATE TABLE IF NOT EXISTS filing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'SC 13D' | 'SC 13D/A' | 'SC 13G' | 'SC 13G/A'
  filer TEXT,
  filed_date TEXT NOT NULL,  -- YYYY-MM-DD
  url TEXT,
  created_at DATETIME,
  UNIQUE(ticker, type, filer, filed_date)
);
CREATE INDEX IF NOT EXISTS idx_filing_events_ticker ON filing_events(ticker, filed_date);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at DATETIME,
  n_obs INTEGER,
  report TEXT             -- JSON PerformanceReport
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,       -- 'ticker' | 'watchlist' | 'global'
  ticker TEXT,
  condition TEXT NOT NULL,   -- AlertCondition
  threshold REAL,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS insider_flow (
  ticker TEXT NOT NULL,
  flow_date TEXT NOT NULL,   -- YYYY-MM-DD
  source TEXT NOT NULL,      -- 'openinsider-sales' | 'edgar144' | 'pipeline-buys'
  buy_value REAL DEFAULT 0,
  sell_value REAL DEFAULT 0,
  form144_count INTEGER DEFAULT 0,
  updated_at DATETIME,
  PRIMARY KEY (ticker, flow_date, source)
);
CREATE INDEX IF NOT EXISTS idx_insider_flow_date ON insider_flow(flow_date);
CREATE TABLE IF NOT EXISTS insider_flow_snapshots (
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  from_date TEXT NOT NULL,
  through_date TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(source, started_at)
);

-- Persisted insider trades. Every scraper is a "latest filings" feed with its own
-- short window (OpenInsider's is 7 days), so before this table a trade existed for
-- the app only while its source page still listed it: after the window rolled past,
-- the aggregate was rebuilt with zero trades and the signal collapsed to score 0 —
-- while insider_flow (90d) kept showing its dollar value, contradicting itself.
-- Trades now accumulate here and aggregates are built from a trailing window, so
-- source coverage gaps and one-off scraper failures no longer erase real signals.
-- Keyed on the exact value so two genuinely different same-day buys by one insider
-- stay separate; cross-source rounding is collapsed by dedupTrades() at read time.
CREATE TABLE IF NOT EXISTS insider_trades (
  ticker TEXT NOT NULL,
  insider_key TEXT NOT NULL,     -- normalizeInsiderName(insiderName)
  trade_date TEXT NOT NULL,      -- YYYY-MM-DD
  value_cents INTEGER NOT NULL,  -- round(value * 100) — integer key, no float compare
  source TEXT NOT NULL,
  source_rank INTEGER NOT NULL,  -- lower = more authoritative (see TRADE_SOURCE_RANK)
  payload TEXT NOT NULL,         -- JSON RawInsiderTrade
  first_seen DATETIME,
  last_seen DATETIME,
  PRIMARY KEY (ticker, insider_key, trade_date, value_cents)
);
CREATE INDEX IF NOT EXISTS idx_insider_trades_date ON insider_trades(trade_date);

CREATE TABLE IF NOT EXISTS ticker_meta (
  ticker TEXT PRIMARY KEY,
  market_cap REAL,
  sector TEXT,
  earnings_date TEXT,
  earnings_timing TEXT,
  short_pct_float REAL,
  float_shares REAL,
  avg_dollar_volume REAL,
  pct_from_52w_high REAL,
  fetched_at DATETIME
);

-- Labeled training data. One row per (ticker, entry date, horizon): the realized
-- SPY-relative alpha of a signal, written once the horizon has ripened. This is
-- what makes the scoring model measurable — the component backtest can read it
-- directly instead of re-fetching hundreds of price series per run, and the set
-- grows on its own with every scheduled scrape.
CREATE TABLE IF NOT EXISTS signal_outcomes (
  ticker TEXT NOT NULL,
  entry_date TEXT NOT NULL,      -- YYYY-MM-DD, max(trade, filing, first-seen)
  horizon INTEGER NOT NULL,      -- calendar days forward (5 … 180; see label-outcomes.ts)
  entry_price REAL,
  exit_price REAL,
  ret REAL,                      -- (exit/entry) - 1
  spy_ret REAL,
  alpha REAL,                    -- ret - spy_ret
  score REAL,                    -- score AT SIGNAL TIME (never recomputed)
  conviction TEXT,
  breakdown TEXT,                -- JSON snapshot of the component values
  computed_at DATETIME,
  PRIMARY KEY (ticker, entry_date, horizon)
);
CREATE INDEX IF NOT EXISTS idx_outcomes_entry ON signal_outcomes(entry_date);

CREATE TABLE IF NOT EXISTS live_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT UNIQUE NOT NULL,
  text TEXT,
  timestamp TEXT,
  url TEXT,
  scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_live_news_timestamp ON live_news(timestamp);
` + PORTFOLIO_SCHEMA + BACKTEST_SCHEMA;

// ──────────────────────────────────────────────────────────────────────────
// Migrations — additive, idempotent. SQLite does NOT support
// "ADD COLUMN IF NOT EXISTS", so we check PRAGMA table_info first.
// ──────────────────────────────────────────────────────────────────────────

function columnExists(database: Database.Database, table: string, column: string): boolean {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function addColumn(database: Database.Database, table: string, column: string, def: string): void {
  if (!columnExists(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

export function runMigrations(database: Database.Database): void {
  const columns: Array<[string, string, string]> = [
    // Feature 1 — signal age + late filing
    ['signals', 'trade_date', 'TEXT'],
    ['signals', 'filing_date', 'TEXT'],
    ['signals', 'late_filing', 'INTEGER DEFAULT 0'],
    // Feature 4 — combo
    ['signals', 'combo_signal', 'INTEGER DEFAULT 0'],
    ['signals', 'combo_detected_at', 'DATETIME'],
    // Feature 5 — earnings
    ['signals', 'earnings_date', 'TEXT'],
    ['signals', 'earnings_timing', 'TEXT'],
    ['signals', 'days_to_earnings', 'INTEGER'],
    // Feature 6 (Tier 3) — sector
    ['signals', 'sector', 'TEXT'],
    // Big player computed at insert time (market-cap-aware)
    ['signals', 'big_player', 'INTEGER DEFAULT 0'],
    // Shadow (A/B) scoring
    ['signals', 'shadow_score', 'REAL'],
    // Sell-side + equity-stats display context
    ['signals', 'insider_flow', 'TEXT'],
    ['signals', 'equity_stats', 'TEXT'],
    // Congressional trading leg
    ['signals', 'politician_score', 'REAL'],
    ['signals', 'politician_trades', 'TEXT'],
    // Feature 8 — VIX
    ['scrape_log', 'vix_at_scrape', 'REAL'],
    // Source breakdown
    ['scrape_log', 'source_breakdown', 'TEXT'],
    // Per-source data-quality counters (see DataQualityStat)
    ['scrape_log', 'data_quality', 'TEXT'],
    // Track record error
    ['insider_track_records', 'error', 'TEXT'],
    // Calendar-pattern classification (routine vs opportunistic)
    ['insider_track_records', 'pattern', 'TEXT'],
    ['insider_track_records', 'price_method_version', 'INTEGER NOT NULL DEFAULT 0'],
    // Equity stats pack (short interest / float / liquidity)
    ['ticker_meta', 'short_pct_float', 'REAL'],
    ['ticker_meta', 'float_shares', 'REAL'],
    ['ticker_meta', 'avg_dollar_volume', 'REAL'],
    // Price context (drawdown from 52-week high)
    ['ticker_meta', 'pct_from_52w_high', 'REAL'],
  ];
  for (const [table, column, def] of columns) {
    try {
      addColumn(database, table, column, def);
    } catch {
      /* already migrated — skip */
    }
  }

  // Labeled outcomes (training data) — additive, safe on existing DBs.
  database.exec(`
    CREATE TABLE IF NOT EXISTS signal_outcomes (
      ticker TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      horizon INTEGER NOT NULL,
      entry_price REAL,
      exit_price REAL,
      ret REAL,
      spy_ret REAL,
      alpha REAL,
      score REAL,
      conviction TEXT,
      breakdown TEXT,
      computed_at DATETIME,
      PRIMARY KEY (ticker, entry_date, horizon)
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_entry ON signal_outcomes(entry_date);
  `);

  // Feature 6 — insider track records (new table)
  database.exec(`
    CREATE TABLE IF NOT EXISTS insider_track_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insider_name TEXT NOT NULL,
      insider_role TEXT,
      total_trades INTEGER,
      profitable_3m INTEGER,
      profitable_6m INTEGER,
      accuracy_3m REAL,
      accuracy_6m REAL,
      avg_return_3m REAL,
      recent_trades TEXT,
      last_updated DATETIME,
      error TEXT,
      pattern TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_itr_name ON insider_track_records(insider_name);
  `);

  // Testing portfolio (v1.4.0). Purely additive: four new tables that never
  // touch signals / signal_outcomes, which carry ~4,500 irreplaceable labeled
  // rows in the committed history DB.
  database.exec(PORTFOLIO_SCHEMA);
  database.exec(BACKTEST_SCHEMA);
}

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────────

/**
 * Open the database.
 *
 * `readonly: true` is for ANALYSIS tools. Without it a report script goes
 * through the full write path — backup, `CREATE TABLE`, migrations, trade
 * backfill — against a file that in this repo is committed history with ~4,000
 * irreplaceable labeled outcomes. Running `analyze:score` really did add a
 * column to `data/insider-tracker.db`. Read-only mode also fails loudly if the
 * schema is behind, which is the right outcome for a tool that only reads.
 */
export function initDatabase(dbPath: string, opts?: { readonly?: boolean }): Database.Database {
  if (opts?.readonly) {
    db = new Database(dbPath, { readonly: true });
    return db;
  }
  // Snapshot before opening/migrating so a bad migration can't wipe history.
  backupDatabaseBeforeMigration(dbPath);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  runMigrations(db);
  quarantineLegacyTickers();
  // Seed the trade window from signal history the first time `insider_trades`
  // exists, so the first run after this lands isn't scored against an empty
  // window. Idempotent and best-effort — a failure here must not block startup.
  try {
    backfillInsiderTradesFromSignals();
  } catch (err) {
    console.error('[db] insider-trade backfill failed (non-fatal):', err);
  }
  // Exit-rule defaults changed in v1.5.0; an existing overlay would mask them.
  // Best-effort like the backfill: a config that cannot be reconciled must not
  // stop the app from starting.
  try {
    const res = migratePortfolioConfig();
    if (res && (res.migrated.length || res.kept.length)) {
      console.log(
        `[db] portfolio config -> v${PORTFOLIO_CONFIG_VERSION}: reset to new defaults [${res.migrated.join(', ') || '-'}], ` +
          `kept your own values for [${res.kept.join(', ') || '-'}]`,
      );
    }
  } catch (err) {
    console.error('[db] portfolio config migration failed (non-fatal):', err);
  }
  db.transaction(() => {
    const config = getPortfolioRunMeta()?.config ?? getPortfolioConfig();
    const positions = getPortfolioPositions();
    recordBacktestBook('Hauptdepot', config, positions, true);
    recordBacktestClosures('Hauptdepot', config, positions);
    const experiment = getPortfolioExperiment('insider-only-v1');
    if (experiment?.state.config && Array.isArray(experiment.state.open) && Array.isArray(experiment.state.closed)) {
      const positions = [...experiment.state.open, ...experiment.state.closed];
      recordBacktestBook('Insider Only', experiment.state.config, positions, true);
      recordBacktestClosures('Insider Only', experiment.state.config, positions);
    }
  })();
  analyzePendingBacktests();
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDatabase() first.');
  return db;
}

/**
 * Consistent snapshot of the live DB into `destPath`, via SQLite's online-backup
 * API. Copying the .db file directly is NOT equivalent: the app runs in WAL
 * mode, so the newest commits live in the -wal sidecar and a plain file copy
 * silently yields stale data. Going through the app's own open handle also
 * avoids a second writer on the live file.
 */
export async function snapshotDatabase(destPath: string): Promise<void> {
  await getDb().backup(destPath);
}

export function closeDatabase(): void {
  db?.close();
  db = null;
  insertSignalStmt = null;
}

// ──────────────────────────────────────────────────────────────────────────
// Row <-> domain mapping
// ──────────────────────────────────────────────────────────────────────────

interface SignalRow {
  id: number;
  ticker: string;
  company_name: string | null;
  score: number;
  conviction_level: string | null;
  total_dollar_volume: number | null;
  insider_count: number | null;
  top_insider_role: string | null;
  top_insider_name: string | null;
  options_activity: string | null;
  raw_trades: string | null;
  score_breakdown: string | null;
  scraped_at: string;
  source_urls: string | null;
  trade_date: string | null;
  filing_date: string | null;
  late_filing: number | null;
  combo_signal: number | null;
  combo_detected_at: string | null;
  earnings_date: string | null;
  earnings_timing: string | null;
  days_to_earnings: number | null;
  sector: string | null;
  big_player: number | null;
  shadow_score: number | null;
  insider_flow: string | null;
  equity_stats: string | null;
  politician_score: number | null;
  politician_trades: string | null;
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const EMPTY_BREAKDOWN: ScoreBreakdown = {
  rankWeight: 0,
  dollarVolumePoints: 0,
  typeModifier: 1,
  clusterMultiplier: 1,
  timingMultiplier: 1,
  optionsScore: 0,
  optionsTimingMultiplier: 1,
  freshnessMultiplier: 1,
  vixMultiplier: 1,
  trackRecordMultiplier: 1,
  valuationMultiplier: 1,
  comboBonus: 0,
  optionsBonus: 0,
  signalAgeDays: null,
  rawScore: 0,
  maxPossibleRaw: 1,
  normalizedScore: 0,
  notes: [],
};

function rowToSignal(row: SignalRow): Signal {
  return {
    id: row.id,
    ticker: row.ticker,
    companyName: row.company_name,
    score: row.score,
    convictionLevel: (row.conviction_level as Signal['convictionLevel']) ?? 'LOW',
    totalDollarVolume: row.total_dollar_volume ?? 0,
    insiderCount: row.insider_count ?? 0,
    topInsiderRole: row.top_insider_role,
    topInsiderName: row.top_insider_name,
    optionsActivity: safeParse<OptionsActivity[]>(row.options_activity, []),
    rawTrades: safeParse<RawInsiderTrade[]>(row.raw_trades, []),
    breakdown: safeParse<ScoreBreakdown>(row.score_breakdown, { ...EMPTY_BREAKDOWN, normalizedScore: row.score }),
    scrapedAt: row.scraped_at,
    sourceUrls: safeParse<string[]>(row.source_urls, []),
    tradeDate: row.trade_date,
    filingDate: row.filing_date,
    lateFiling: !!row.late_filing,
    comboSignal: !!row.combo_signal,
    comboDetectedAt: row.combo_detected_at,
    earningsDate: row.earnings_date,
    earningsTiming: row.earnings_timing,
    daysToEarnings: row.days_to_earnings,
    // Rows from before the big_player column default to 0 → static-list fallback.
    bigPlayer: !!row.big_player || isBigPlayer(row.ticker),
    sector: row.sector,
    shadowScore: row.shadow_score,
    insiderFlow: safeParse<Signal['insiderFlow']>(row.insider_flow, null),
    stats: safeParse<Signal['stats']>(row.equity_stats, null),
    politicianScore: row.politician_score ?? undefined,
    politicianTrades: safeParse<PoliticianTrade[]>(row.politician_trades, []),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Signals
// ──────────────────────────────────────────────────────────────────────────

// Prepared once and reused: insertSignal runs in a loop (100+ rows per scrape
// batch) and re-compiling the SQL per row is pure overhead.
let insertSignalStmt: Database.Statement | null = null;

export function insertSignal(signal: Signal, context: DecisionContext | null = null): number {
  return getDb().transaction(() => {
    const id = insertSignalRow(signal);
    captureDecision({ ...signal, id }, context);
    return id;
  })();
}

function insertSignalRow(signal: Signal): number {
  recordTickerQuality(signal.ticker);
  const stmt = (insertSignalStmt ??= getDb().prepare(`
    INSERT INTO signals (
      ticker, company_name, score, conviction_level, total_dollar_volume,
      insider_count, top_insider_role, top_insider_name, options_activity,
      raw_trades, score_breakdown, scraped_at, source_urls,
      trade_date, filing_date, late_filing, combo_signal, combo_detected_at,
      earnings_date, earnings_timing, days_to_earnings, sector, big_player, shadow_score,
      insider_flow, equity_stats, politician_score, politician_trades
    ) VALUES (
      @ticker, @company_name, @score, @conviction_level, @total_dollar_volume,
      @insider_count, @top_insider_role, @top_insider_name, @options_activity,
      @raw_trades, @score_breakdown, @scraped_at, @source_urls,
      @trade_date, @filing_date, @late_filing, @combo_signal, @combo_detected_at,
      @earnings_date, @earnings_timing, @days_to_earnings, @sector, @big_player, @shadow_score,
      @insider_flow, @equity_stats, @politician_score, @politician_trades
    )
  `));
  const info = stmt.run({
    ticker: signal.ticker,
    company_name: signal.companyName ?? null,
    score: signal.score,
    conviction_level: signal.convictionLevel,
    total_dollar_volume: signal.totalDollarVolume,
    insider_count: signal.insiderCount,
    top_insider_role: signal.topInsiderRole,
    top_insider_name: signal.topInsiderName ?? null,
    options_activity: JSON.stringify(signal.optionsActivity ?? []),
    raw_trades: JSON.stringify(signal.rawTrades ?? []),
    score_breakdown: JSON.stringify(signal.breakdown),
    scraped_at: signal.scrapedAt ?? new Date().toISOString(),
    source_urls: JSON.stringify(signal.sourceUrls ?? []),
    trade_date: signal.tradeDate ?? null,
    filing_date: signal.filingDate ?? null,
    late_filing: signal.lateFiling ? 1 : 0,
    combo_signal: signal.comboSignal ? 1 : 0,
    combo_detected_at: signal.comboDetectedAt ?? null,
    earnings_date: signal.earningsDate ?? null,
    earnings_timing: signal.earningsTiming ?? null,
    days_to_earnings: signal.daysToEarnings ?? null,
    sector: signal.sector ?? null,
    big_player: signal.bigPlayer ? 1 : 0,
    shadow_score: signal.shadowScore ?? null,
    insider_flow: signal.insiderFlow ? JSON.stringify(signal.insiderFlow) : null,
    equity_stats: signal.stats ? JSON.stringify(signal.stats) : null,
    politician_score: signal.politicianScore ?? null,
    politician_trades: signal.politicianTrades && signal.politicianTrades.length ? JSON.stringify(signal.politicianTrades) : null,
  });
  return info.lastInsertRowid as number;
}

/** Insert a full batch of signals from one scrape session in a transaction. */
export function insertSignals(signals: Signal[], contexts: Record<string, DecisionContext> = {}): void {
  const insertMany = getDb().transaction((items: Signal[]) => {
    for (const s of items) insertSignal(s, contexts[s.ticker] ?? null);
  });
  insertMany(signals);
}

/** How long a ticker may go unseen (relative to the newest scrape) before it drops
 *  off the "current" dashboard snapshot — covers weekends + a couple missed runs. */
const ACTIVE_SIGNAL_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * Latest signal per ticker that is still ACTIVE — i.e. seen within the active
 * window of the most recent scrape. Without this, a ticker scored once weeks ago
 * (and never re-scraped) lingered on the dashboard forever with a stale score.
 */
export function getLatestSignals(): Signal[] {
  const db = getDb();
  const max = (db.prepare(`SELECT MAX(scraped_at) AS at FROM signals`).get() as { at: string | null }).at;
  if (!max) return [];
  const maxMs = Date.parse(max);
  const cutoff = Number.isNaN(maxMs) ? '' : new Date(maxMs - ACTIVE_SIGNAL_WINDOW_MS).toISOString();
  const rows = db
    .prepare(
      `
      SELECT s.* FROM signals s
      JOIN (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY scraped_at DESC, id DESC) AS rn
        FROM signals WHERE scraped_at >= ?
      ) latest ON s.id = latest.id AND latest.rn = 1
      WHERE s.scraped_at >= ?
      ORDER BY s.score DESC
    `,
    )
    .all(cutoff, cutoff) as SignalRow[];
  const active = new Map<string, Signal>();
  for (const signal of rows.map(rowToSignal).filter((r) => !tickerIssue(r.ticker))) {
    const ticker = resolvedTicker(signal.ticker, signal.scrapedAt.slice(0, 10));
    const previous = active.get(ticker);
    if (!previous || signal.scrapedAt > previous.scrapedAt) active.set(ticker, { ...signal, ticker });
  }
  return [...active.values()].sort((a, b) => b.score - a.score);
}

/** Latest signals passed through the time/type/conviction filter (Feature 7). */
export function getFilteredSignals(filter: SignalFilter): Signal[] {
  return filterSignals(getLatestSignals(), filter);
}

/** Most recent single signal for one ticker. */
export function getSignalByTicker(ticker: string): Signal | null {
  const row = getDb()
    .prepare(`SELECT * FROM signals WHERE ticker = ? ORDER BY scraped_at DESC, id DESC LIMIT 1`)
    .get(ticker.toUpperCase()) as SignalRow | undefined;
  return row ? rowToSignal(row) : null;
}

/** Full time-series of signals for one ticker (oldest → newest). */
export function getSignalHistory(ticker: string): Signal[] {
  const rows = getDb()
    .prepare(`SELECT * FROM signals WHERE ticker = ? ORDER BY scraped_at ASC, id ASC`)
    .all(ticker.toUpperCase()) as SignalRow[];
  return rows.map(rowToSignal);
}

/** Signals belonging to the most recent scrape session (same scraped_at batch). */
export function getMostRecentSessionSignals(): Signal[] {
  const latest = getDb()
    .prepare(`SELECT MAX(scraped_at) AS at FROM signals`)
    .get() as { at: string | null };
  if (!latest?.at) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM signals WHERE scraped_at = ? ORDER BY score DESC`)
    .all(latest.at) as SignalRow[];
  return rows.map(rowToSignal);
}

// ──────────────────────────────────────────────────────────────────────────
// Watchlist
// ──────────────────────────────────────────────────────────────────────────

export function getWatchlist(): WatchlistItem[] {
  const rows = getDb()
    .prepare(`SELECT id, ticker, added_at, notes FROM watchlist ORDER BY added_at DESC`)
    .all() as { id: number; ticker: string; added_at: string; notes: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    addedAt: r.added_at,
    notes: r.notes,
    signal: getSignalByTicker(r.ticker),
  }));
}

export function addToWatchlist(ticker: string, notes?: string): WatchlistItem[] {
  getDb()
    .prepare(
      `INSERT INTO watchlist (ticker, notes, added_at)
       VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET notes = excluded.notes`,
    )
    .run(ticker.toUpperCase(), notes ?? null, new Date().toISOString());
  return getWatchlist();
}

export function removeFromWatchlist(ticker: string): WatchlistItem[] {
  getDb().prepare(`DELETE FROM watchlist WHERE ticker = ?`).run(ticker.toUpperCase());
  return getWatchlist();
}

// ──────────────────────────────────────────────────────────────────────────
// Scrape log
// ──────────────────────────────────────────────────────────────────────────

export function startScrapeLog(sources: string[]): number {
  const info = getDb()
    .prepare(
      `INSERT INTO scrape_log (started_at, sources_scraped, signals_found, status)
       VALUES (?, ?, 0, 'partial')`,
    )
    .run(new Date().toISOString(), JSON.stringify(sources));
  return info.lastInsertRowid as number;
}

export function finishScrapeLog(
  id: number,
  data: {
    signalsFound: number;
    status: ScrapeLogEntry['status'];
    sourcesScraped: string[];
    vixAtScrape?: number | null;
    sourceBreakdown?: Record<string, number> | null;
    dataQuality?: DataQualityReport | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE scrape_log
       SET finished_at = ?, signals_found = ?, status = ?, sources_scraped = ?, vix_at_scrape = ?,
           source_breakdown = ?, data_quality = ?
       WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      data.signalsFound,
      data.status,
      JSON.stringify(data.sourcesScraped),
      data.vixAtScrape ?? null,
      data.sourceBreakdown ? JSON.stringify(data.sourceBreakdown) : null,
      data.dataQuality ? JSON.stringify(data.dataQuality) : null,
      id,
    );
}

export function getScrapeLogs(limit = 50): ScrapeLogEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM scrape_log ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(limit) as {
    id: number;
    started_at: string;
    finished_at: string | null;
    sources_scraped: string | null;
    signals_found: number | null;
    status: string | null;
    vix_at_scrape: number | null;
    source_breakdown: string | null;
    data_quality: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    sourcesScraped: safeParse<string[]>(r.sources_scraped, []),
    signalsFound: r.signals_found ?? 0,
    status: (r.status as ScrapeLogEntry['status']) ?? 'partial',
    vixAtScrape: r.vix_at_scrape,
    sourceBreakdown: safeParse<Record<string, number>>(r.source_breakdown, {}),
    dataQuality: safeParse<DataQualityReport | null>(r.data_quality, null),
  }));
}

/** Per-run source_breakdown maps, most recent first (for source health checks). */
export function getRecentSourceBreakdowns(limit = 20): Record<string, number>[] {
  const rows = getDb()
    .prepare(
      `SELECT source_breakdown FROM scrape_log WHERE source_breakdown IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as { source_breakdown: string | null }[];
  return rows.map((r) => safeParse<Record<string, number>>(r.source_breakdown, {}));
}

export function getLastScrapeTime(): string | null {
  const row = getDb()
    .prepare(`SELECT finished_at FROM scrape_log WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`)
    .get() as { finished_at: string | null } | undefined;
  return row?.finished_at ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// Insider track records (Feature 6) — cached, lazy-filled
// ──────────────────────────────────────────────────────────────────────────

interface TrackRecordRow {
  insider_name: string;
  insider_role: string | null;
  total_trades: number | null;
  profitable_3m: number | null;
  profitable_6m: number | null;
  accuracy_3m: number | null;
  accuracy_6m: number | null;
  avg_return_3m: number | null;
  recent_trades: string | null;
  last_updated: string | null;
  error: string | null;
  pattern: string | null;
}

function rowToTrackRecord(row: TrackRecordRow): InsiderTrackRecord {
  return {
    insiderName: row.insider_name,
    insiderRole: row.insider_role,
    totalTrades: row.total_trades ?? 0,
    profitable3m: row.profitable_3m ?? 0,
    profitable6m: row.profitable_6m ?? 0,
    accuracy3m: row.accuracy_3m ?? 0,
    accuracy6m: row.accuracy_6m ?? 0,
    avgReturn3m: row.avg_return_3m ?? 0,
    recentTrades: safeParse<InsiderHistoricalTrade[]>(row.recent_trades, []),
    lastUpdated: row.last_updated ?? new Date().toISOString(),
    pattern: row.pattern === 'routine' || row.pattern === 'opportunistic' ? row.pattern : null,
    error: row.error ?? undefined,
  };
}

export function getTrackRecord(name: string): InsiderTrackRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM insider_track_records WHERE insider_name = ? AND price_method_version = 1`)
    .get(name) as TrackRecordRow | undefined;
  return row ? rowToTrackRecord(row) : null;
}

export function upsertTrackRecord(record: InsiderTrackRecord): void {
  // Transient or partial results must never become scoring inputs.
  if (record.error && !['No post-trade performance data yet.', 'No history page available for this insider.'].includes(record.error)) return;
  getDb()
    .prepare(
      `INSERT INTO insider_track_records (
        insider_name, insider_role, total_trades, profitable_3m, profitable_6m,
        accuracy_3m, accuracy_6m, avg_return_3m, recent_trades, last_updated, error, pattern, price_method_version
      ) VALUES (
        @insider_name, @insider_role, @total_trades, @profitable_3m, @profitable_6m,
        @accuracy_3m, @accuracy_6m, @avg_return_3m, @recent_trades, @last_updated, @error, @pattern, 1
      )
      ON CONFLICT(insider_name) DO UPDATE SET
        insider_role = excluded.insider_role,
        total_trades = excluded.total_trades,
        profitable_3m = excluded.profitable_3m,
        profitable_6m = excluded.profitable_6m,
        accuracy_3m = excluded.accuracy_3m,
        accuracy_6m = excluded.accuracy_6m,
        avg_return_3m = excluded.avg_return_3m,
        recent_trades = excluded.recent_trades,
        last_updated = excluded.last_updated,
        error = excluded.error,
        pattern = excluded.pattern,
        price_method_version = excluded.price_method_version`,
    )
    .run({
      insider_name: record.insiderName,
      insider_role: record.insiderRole ?? null,
      total_trades: record.totalTrades,
      profitable_3m: record.profitable3m,
      profitable_6m: record.profitable6m,
      accuracy_3m: record.accuracy3m,
      accuracy_6m: record.accuracy6m,
      avg_return_3m: record.avgReturn3m,
      recent_trades: JSON.stringify(record.recentTrades ?? []),
      last_updated: record.lastUpdated ?? new Date().toISOString(),
      error: record.error ?? null,
      pattern: record.pattern ?? null,
    });
}

// ──────────────────────────────────────────────────────────────────────────
// Settings (single JSON row keyed 'config')
// ──────────────────────────────────────────────────────────────────────────

export function getSettings(): AppSettings {
  const row = getDb().prepare(`SELECT value FROM app_settings WHERE key = 'config'`).get() as
    | { value: string }
    | undefined;
  const stored = safeParse<Partial<AppSettings>>(row?.value ?? null, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    scheduleTimes: { ...DEFAULT_SETTINGS.scheduleTimes, ...stored.scheduleTimes },
    roleFilters: { ...DEFAULT_SETTINGS.roleFilters, ...stored.roleFilters },
    sources: { ...DEFAULT_SETTINGS.sources, ...stored.sources },
  };
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const merged: AppSettings = {
    ...current,
    ...partial,
    scheduleTimes: { ...current.scheduleTimes, ...partial.scheduleTimes },
    roleFilters: { ...current.roleFilters, ...partial.roleFilters },
    sources: { ...current.sources, ...partial.sources },
  };
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES ('config', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(JSON.stringify(merged));
  return merged;
}

// ──────────────────────────────────────────────────────────────────────────
// Shadow scoring config (A/B framework) — stored beside the main settings
// ──────────────────────────────────────────────────────────────────────────

export function getShadowScoringConfig(): Partial<ScoringConfig> | null {
  const row = getDb().prepare(`SELECT value FROM app_settings WHERE key = 'shadow_scoring'`).get() as
    | { value: string }
    | undefined;
  if (!row?.value) return null;
  const parsed = safeParse<Partial<ScoringConfig>>(row.value, {});
  return parsed && Object.keys(parsed).length > 0 ? parsed : null;
}

export function setShadowScoringConfig(config: Partial<ScoringConfig> | null): Partial<ScoringConfig> | null {
  if (config == null || Object.keys(config).length === 0) {
    getDb().prepare(`DELETE FROM app_settings WHERE key = 'shadow_scoring'`).run();
    return null;
  }
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES ('shadow_scoring', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(JSON.stringify(config));
  return config;
}

// ──────────────────────────────────────────────────────────────────────────
// Maintenance
// ──────────────────────────────────────────────────────────────────────────

/** Clear signal + scrape history. Watchlist, settings, track records preserved. */
export function clearDatabase(): void {
  const tx = getDb().transaction(() => {
    getDb().prepare(`DELETE FROM signals`).run();
    getDb().prepare(`DELETE FROM scrape_log`).run();
    getDb().prepare(`DELETE FROM live_news`).run();
  });
  tx();
  getDb().exec('VACUUM');
}

export function insertNewsItem(news: { tweetId: string; text: string; timestamp: string; url: string }): boolean {
  const info = getDb()
    .prepare(
      `INSERT INTO live_news (tweet_id, text, timestamp, url)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tweet_id) DO NOTHING`,
    )
    .run(news.tweetId, news.text, news.timestamp, news.url);
  return info.changes > 0;
}

export function getNewsItems(): NewsItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM live_news ORDER BY timestamp DESC, id DESC`)
    .all() as {
    id: number;
    tweet_id: string;
    text: string | null;
    timestamp: string | null;
    url: string | null;
    scraped_at: string;
  }[];

  const cutoff = Date.now() - 12 * 60 * 60 * 1000;

  return rows
    .filter((r) => {
      if (!r.timestamp) return false;
      const t = Date.parse(r.timestamp);
      return !Number.isNaN(t) && t >= cutoff;
    })
    .map((r) => ({
      id: r.id,
      tweetId: r.tweet_id,
      text: r.text ?? '',
      timestamp: r.timestamp ?? '',
      url: r.url ?? '',
      scrapedAt: r.scraped_at,
    }));
}

/** Recent news items whose text cashtags the ticker (e.g. "$NVDA"). */
export function getNewsForTicker(ticker: string): NewsItem[] {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return [];
  const rows = getDb()
    .prepare(
      `SELECT * FROM live_news WHERE upper(text) LIKE '%$' || ? || '%' ORDER BY timestamp DESC, id DESC LIMIT 12`,
    )
    .all(sym) as {
    id: number;
    tweet_id: string;
    text: string | null;
    timestamp: string | null;
    url: string | null;
    scraped_at: string;
  }[];
  // The LIKE above is only a coarse prefilter — it prefix-matches, so "$T"
  // would return $TSLA/$TXN tweets. Require an exact cashtag boundary.
  const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`\\$${escaped}\\b`, 'i');
  return rows.filter((r) => exact.test(r.text ?? '')).map((r) => ({
    id: r.id,
    tweetId: r.tweet_id,
    text: r.text ?? '',
    timestamp: r.timestamp ?? '',
    url: r.url ?? '',
    scrapedAt: r.scraped_at,
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// Congressional trades (STOCK Act disclosures)
// ──────────────────────────────────────────────────────────────────────────

/** Upsert scraped politician trades; the UNIQUE constraint dedups at the DB level. */
export function upsertPoliticianTrades(trades: PoliticianTrade[]): number {
  if (!trades.length) return 0;
  const stmt = getDb().prepare(
    `INSERT INTO politician_trades
       (politician, chamber, party, committee, ticker, transaction_type, amount_midpoint,
        trade_date, disclosure_date, days_to_disclose, scraped_at)
     VALUES
       (@politician, @chamber, @party, @committee, @ticker, @transaction_type, @amount_midpoint,
        @trade_date, @disclosure_date, @days_to_disclose, @scraped_at)
     ON CONFLICT(politician, ticker, trade_date, transaction_type) DO UPDATE SET
       party = COALESCE(excluded.party, party),
       committee = COALESCE(excluded.committee, committee),
       amount_midpoint = excluded.amount_midpoint,
       disclosure_date = excluded.disclosure_date,
       days_to_disclose = excluded.days_to_disclose`,
  );
  // ON CONFLICT DO UPDATE reports a "change" for idempotent updates too, so
  // count genuine inserts by watching the AUTOINCREMENT rowid advance past the
  // pre-run maximum (an update-conflict reuses the existing, smaller rowid).
  const maxRow = getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM politician_trades`).get() as { m: number };
  let runningMax = maxRow.m;
  let inserted = 0;
  const tx = getDb().transaction((items: PoliticianTrade[]) => {
    for (const t of items) {
      if (t.chamber !== 'House' && t.chamber !== 'Senate') continue;
      if (t.transactionType !== 'buy' && t.transactionType !== 'sell') continue;
      const info = stmt.run({
        politician: t.politician,
        chamber: t.chamber,
        party: t.party ?? null,
        committee: t.committee ?? null,
        ticker: t.ticker.toUpperCase(),
        transaction_type: t.transactionType,
        amount_midpoint: t.amountMidpoint,
        trade_date: t.tradeDate,
        disclosure_date: t.disclosureDate,
        days_to_disclose: t.daysToDisclose,
        scraped_at: t.scrapedAt,
      });
      const rowid = Number(info.lastInsertRowid);
      if (info.changes > 0 && rowid > runningMax) {
        runningMax = rowid;
        inserted++;
      }
    }
  });
  tx(trades);
  return inserted;
}

interface PoliticianTradeRow {
  id: number;
  politician: string;
  chamber: string;
  party: string | null;
  committee: string | null;
  ticker: string;
  transaction_type: string;
  amount_midpoint: number;
  trade_date: string;
  disclosure_date: string;
  days_to_disclose: number | null;
  scraped_at: string;
}

function rowToPoliticianTrade(r: PoliticianTradeRow): PoliticianTrade {
  return {
    id: r.id,
    politician: r.politician,
    chamber: r.chamber === 'Senate' ? 'Senate' : 'House',
    party: r.party ?? '',
    committee: r.committee ?? undefined,
    ticker: r.ticker,
    transactionType: r.transaction_type === 'sell' ? 'sell' : 'buy',
    amountMidpoint: r.amount_midpoint,
    tradeDate: r.trade_date,
    disclosureDate: r.disclosure_date,
    daysToDisclose: r.days_to_disclose,
    scrapedAt: r.scraped_at,
  };
}

/** Politician trades for a ticker within the trailing window (default 90d). */
export function getPoliticianTradesForTicker(ticker: string, days = 90): PoliticianTrade[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT * FROM politician_trades WHERE ticker = ? AND trade_date >= ? ORDER BY trade_date DESC LIMIT 40`,
    )
    .all(ticker.toUpperCase(), cutoff) as PoliticianTradeRow[];
  return rows.map(rowToPoliticianTrade);
}

/** Distinct tickers with any politician trade in the trailing window. */
export function getPoliticianTradeTickers(days = 90): string[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(`SELECT DISTINCT ticker FROM politician_trades WHERE trade_date >= ?`)
    .all(cutoff) as { ticker: string }[];
  return rows.map((r) => r.ticker);
}

// ──────────────────────────────────────────────────────────────────────────
// Activist / large-holder filing events (SC 13D/13G)
// ──────────────────────────────────────────────────────────────────────────

/** Insert events; returns the subset that was NEW (not seen before). */
export function upsertFilingEvents(events: FilingEvent[]): FilingEvent[] {
  if (!events.length) return [];
  const stmt = getDb().prepare(
    `INSERT INTO filing_events (ticker, type, filer, filed_date, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, type, filer, filed_date) DO NOTHING`,
  );
  const fresh: FilingEvent[] = [];
  const now = new Date().toISOString();
  const tx = getDb().transaction((items: FilingEvent[]) => {
    for (const e of items) {
      const info = stmt.run(e.ticker.toUpperCase(), e.type, e.filer ?? null, e.filedDate, e.url, now);
      if (info.changes > 0) fresh.push(e);
    }
  });
  tx(events);
  return fresh;
}

export function getRecentFilingEvents(ticker: string, days = 90): FilingEvent[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT ticker, type, filer, filed_date, url FROM filing_events
       WHERE ticker = ? AND filed_date >= ? ORDER BY filed_date DESC LIMIT 10`,
    )
    .all(ticker.toUpperCase(), cutoff) as {
    ticker: string;
    type: string;
    filer: string | null;
    filed_date: string;
    url: string | null;
  }[];
  return rows.map((r) => ({ ticker: r.ticker, type: r.type, filer: r.filer, filedDate: r.filed_date, url: r.url ?? '' }));
}

// ──────────────────────────────────────────────────────────────────────────
// Performance dashboard (calibration report) persistence
// ──────────────────────────────────────────────────────────────────────────

export function insertBacktestRun(report: PerformanceReport): void {
  getDb()
    .prepare(`INSERT INTO backtest_runs (ran_at, n_obs, report) VALUES (?, ?, ?)`)
    .run(report.ranAt, report.nObservations, JSON.stringify(report));
}

export function getLatestBacktestRun(): PerformanceReport | null {
  const row = getDb()
    .prepare(`SELECT report FROM backtest_runs ORDER BY id DESC LIMIT 1`)
    .get() as { report: string | null } | undefined;
  return row?.report ? safeParse<PerformanceReport>(row.report, null as unknown as PerformanceReport) : null;
}

/** Raw signal rows for outcome analysis (id-ordered, minimal columns). */
export interface BacktestSignalRow {
  ticker: string;
  score: number;
  conviction_level: string | null;
  scraped_at: string;
  trade_date: string | null;
  filing_date: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Labeled outcomes (training data)
// ──────────────────────────────────────────────────────────────────────────

export interface OutcomeCandidate {
  ticker: string;
  entryDate: string; // YYYY-MM-DD
  score: number;
  conviction: string | null;
  breakdown: string | null;
  companyName?: string | null;
  sourceUrls?: string[];
  observedDate?: string;
  politicianTrades?: PoliticianTrade[];
}

/**
 * One candidate per ticker per entry date, taken from the FIRST time we saw that
 * signal (MIN(id)) so the score is the one that was actionable then — scoring a
 * signal by a later, already-decayed row would leak hindsight into the label.
 * Entry date follows the backtest convention: max(trade, filing, first-seen).
 */
export function getOutcomeCandidates(): OutcomeCandidate[] {
  // Entry date is resolved in JS: SQLite's scalar MAX(a,b,c) cannot be mixed with
  // an aggregate MIN() in the same expression (it silently yields garbage).
  const rows = getDb()
    .prepare(
      `
      SELECT ticker, trade_date, filing_date, substr(scraped_at, 1, 10) AS seen_date,
             score, conviction_level AS conviction, score_breakdown AS breakdown, company_name, source_urls, politician_trades
      FROM signals
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY ticker, substr(scraped_at, 1, 10) ORDER BY scraped_at, id
          ) AS rn FROM signals
        ) WHERE rn = 1
      )
      ORDER BY scraped_at, id
    `,
    )
    .all() as {
    ticker: string;
    trade_date: string | null;
    filing_date: string | null;
    seen_date: string;
    score: number;
    conviction: string | null;
    breakdown: string | null;
    company_name: string | null;
    source_urls: string | null;
    politician_trades: string | null;
  }[];

  const ymd = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const out = new Map<string, OutcomeCandidate>();
  for (const r of rows) {
    // max(trade, filing, first-seen) — the date the signal was actionable.
    const entryDate = [ymd(r.trade_date), ymd(r.filing_date), ymd(r.seen_date)].sort().pop() || '';
    if (!entryDate) continue;
    const key = `${r.ticker}|${entryDate}`;
    if (!out.has(key)) {
      out.set(key, {
        ticker: r.ticker,
        entryDate,
        score: r.score,
        conviction: r.conviction,
        breakdown: r.breakdown,
        companyName: r.company_name,
        sourceUrls: r.source_urls ? JSON.parse(r.source_urls) : [],
        observedDate: r.seen_date,
        politicianTrades: r.politician_trades ? JSON.parse(r.politician_trades) : [],
      });
    }
  }
  return [...out.values()].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
}

/** Horizons already labeled, so a re-run only fetches what is genuinely missing. */
/**
 * Signals that were labeled at SOME horizon in the past and can still ripen at a
 * longer one.
 *
 * `getOutcomeCandidates` reads `signals`, which is a rolling scrape window — on
 * this database it holds nine days. That was invisible while the longest horizon
 * was 20 days and every horizon ripened inside the retention window. It stops
 * being invisible the moment a 40-, 90- or 180-day horizon is added: by the time
 * such a horizon ripens, the row that would have produced the label is long gone,
 * and the labeler writes NOTHING no matter how long it runs. Measured: extending
 * HORIZONS alone produced 0 new rows, because 0 candidates had an entry date
 * older than nine days.
 *
 * `signal_outcomes` is the durable record — it keeps (ticker, entry_date, score,
 * conviction, breakdown) for every signal ever labeled. Reading candidates back
 * out of it lets a signal first seen in July finally get its 40-day label in
 * August. The score is the one stored AT SIGNAL TIME, so nothing inherits
 * hindsight, and `MAX(score)` matches how the portfolio's own candidate query
 * collapses a (ticker, date) group.
 */
export function getOutcomeBackfillCandidates(): OutcomeCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT ticker, entry_date AS entryDate, MAX(score) AS score, conviction, breakdown
       FROM signal_outcomes
       GROUP BY ticker, entry_date
       ORDER BY entry_date`,
    )
    .all() as { ticker: string; entryDate: string; score: number; conviction: string | null; breakdown: string | null }[];
  return rows.map((r) => ({
    ticker: r.ticker,
    entryDate: r.entryDate,
    score: r.score,
    conviction: r.conviction,
    breakdown: r.breakdown,
  }));
}

export function getLabeledKeys(): Set<string> {
  const rows = getDb()
    .prepare(`SELECT ticker, entry_date, horizon FROM signal_outcomes`)
    .all() as { ticker: string; entry_date: string; horizon: number }[];
  return new Set(rows.map((r) => `${r.ticker}|${r.entry_date}|${r.horizon}`));
}

export interface SignalOutcome {
  ticker: string;
  entryDate: string;
  horizon: number;
  entryPrice: number;
  exitPrice: number;
  ret: number;
  spyRet: number;
  alpha: number;
  score: number;
  conviction: string | null;
  breakdown: string | null;
}

export function upsertSignalOutcomes(rows: SignalOutcome[]): number {
  if (!rows.length) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO signal_outcomes
      (ticker, entry_date, horizon, entry_price, exit_price, ret, spy_ret, alpha, score, conviction, breakdown, computed_at)
    VALUES (@ticker, @entryDate, @horizon, @entryPrice, @exitPrice, @ret, @spyRet, @alpha, @score, @conviction, @breakdown, @computedAt)
    ON CONFLICT(ticker, entry_date, horizon) DO NOTHING
  `);
  const now = new Date().toISOString();
  let n = 0;
  db.transaction((list: SignalOutcome[]) => {
    for (const r of list) n += stmt.run({ ...r, computedAt: now }).changes;
  })(rows);
  return n;
}

/** Labeled rows per horizon + how many carry a NON-CONSTANT value per component. */
export function getOutcomeCoverage(): {
  perHorizon: { horizon: number; n: number }[];
  components: { name: string; varying: number; total: number }[];
} {
  const db = getDb();
  const perHorizon = db
    .prepare(`SELECT horizon, COUNT(*) AS n FROM signal_outcomes GROUP BY horizon ORDER BY horizon`)
    .all() as { horizon: number; n: number }[];
  const rows = db
    .prepare(`SELECT breakdown FROM signal_outcomes WHERE horizon = 20 AND breakdown IS NOT NULL`)
    .all() as { breakdown: string }[];
  const counters: Record<string, number> = {};
  const bump = (k: string, on: boolean) => {
    counters[k] = (counters[k] ?? 0) + (on ? 1 : 0);
  };
  for (const r of rows) {
    let b: any = {};
    try {
      b = JSON.parse(r.breakdown) ?? {};
    } catch {
      /* skip */
    }
    bump('Options score', (b.optionsScore ?? 0) !== 0);
    bump('Cluster', (b.clusterMultiplier ?? 1) !== 1);
    bump('Track record', (b.trackRecordMultiplier ?? 1) !== 1);
    bump('Combo', (b.comboBonus ?? 0) !== 0 || !!b.politicianComboTier);
    bump('VIX', (b.vixMultiplier ?? 1) !== 1);
    bump('Valuation', (b.valuationMultiplier ?? 1) !== 1);
    bump('Earnings timing', (b.timingMultiplier ?? 1) !== 1);
    bump('Freshness', (b.freshnessMultiplier ?? 1) !== 1);
    bump('Insider rank', (b.rankWeight ?? 0) !== 0);
  }
  return {
    perHorizon,
    components: Object.entries(counters).map(([name, varying]) => ({ name, varying, total: rows.length })),
  };
}

/**
 * Score + realized alpha pairs for one horizon (score-calibration report).
 *
 * `ticker` and `breakdown` come along because the calibration report cannot be
 * honest without them: the ticker is the CLUSTER for the effective-sample-size
 * correction (the same name recurs day after day with overlapping holding
 * periods), and the breakdown is what distinguishes a real signal from a row
 * that only exists because a single congressional print named the ticker.
 */
export function getScoreOutcomeRows(
  horizon: number,
): { score: number; alpha: number; entryDate: string; ticker: string; breakdown: string | null }[] {
  return getDb()
    .prepare(
      `SELECT score, alpha, entry_date AS entryDate, ticker, breakdown
       FROM signal_outcomes
       WHERE horizon = ? AND alpha IS NOT NULL AND score IS NOT NULL`,
    )
    .all(horizon) as { score: number; alpha: number; entryDate: string; ticker: string; breakdown: string | null }[];
}

/**
 * How often each scoring factor actually DEVIATES from its neutral value across
 * the stored signals. A factor that never moves is not disproven — it was never
 * testable — and that distinction has to be visible, or "no measured alpha" gets
 * read as "no alpha".
 */
export function getFactorActivity(): { name: string; active: number; total: number }[] {
  const rows = getDb()
    .prepare(`SELECT score_breakdown FROM signals WHERE score_breakdown IS NOT NULL`)
    .all() as { score_breakdown: string }[];
  const counters: Record<string, number> = {};
  const bump = (k: string, on: boolean) => {
    counters[k] = (counters[k] ?? 0) + (on ? 1 : 0);
  };
  let total = 0;
  for (const r of rows) {
    let b: Record<string, unknown> = {};
    try {
      b = (JSON.parse(r.score_breakdown) as Record<string, unknown>) ?? {};
    } catch {
      continue;
    }
    total++;
    const num = (k: string, dflt: number) => (typeof b[k] === 'number' ? (b[k] as number) : dflt);
    bump('Insider rank', num('rankWeight', 0) > 0);
    bump('Dollar volume', num('dollarVolumePoints', 0) > 1);
    bump('Transaction type', num('typeModifier', 1) !== 1);
    bump('Cluster', num('clusterMultiplier', 1) !== 1);
    bump('Earnings timing (insider)', num('timingMultiplier', 1) !== 1);
    bump('Earnings timing (options)', num('optionsTimingMultiplier', 1) !== 1);
    bump('Options flow', num('optionsScore', 0) !== 0);
    bump('Freshness', num('freshnessMultiplier', 1) !== 1);
    bump('VIX', num('vixMultiplier', 1) !== 1);
    bump('Track record', num('trackRecordMultiplier', 1) !== 1);
    bump('Valuation', num('valuationMultiplier', 1) !== 1);
    bump('Corroboration mult', num('comboBonus', 0) !== 0);
    bump('Politician leg', num('politicianScore', 0) !== 0);
  }
  return Object.entries(counters).map(([name, active]) => ({ name, active, total }));
}

export function getSignalRowsForBacktest(): BacktestSignalRow[] {
  return getDb()
    .prepare(
      `SELECT ticker, score, conviction_level, scraped_at, trade_date, filing_date FROM signals ORDER BY scraped_at ASC`,
    )
    .all() as BacktestSignalRow[];
}

// ──────────────────────────────────────────────────────────────────────────
// Custom alert rules
// ──────────────────────────────────────────────────────────────────────────

interface AlertRuleRow {
  id: number;
  scope: string;
  ticker: string | null;
  condition: string;
  threshold: number | null;
  enabled: number | null;
  created_at: string | null;
}

function rowToAlertRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    scope: (row.scope as AlertRule['scope']) ?? 'global',
    ticker: row.ticker,
    condition: (row.condition as AlertRule['condition']) ?? 'score_gte',
    threshold: row.threshold,
    enabled: !!row.enabled,
    createdAt: row.created_at ?? undefined,
  };
}

export function getAlertRules(): AlertRule[] {
  const rows = getDb().prepare(`SELECT * FROM alert_rules ORDER BY id ASC`).all() as AlertRuleRow[];
  return rows.map(rowToAlertRule);
}

export function addAlertRule(rule: AlertRule): void {
  getDb()
    .prepare(
      `INSERT INTO alert_rules (scope, ticker, condition, threshold, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rule.scope,
      rule.ticker ? rule.ticker.trim().toUpperCase() : null,
      rule.condition,
      rule.threshold ?? null,
      rule.enabled ? 1 : 0,
      new Date().toISOString(),
    );
}

export function deleteAlertRule(id: number): void {
  getDb().prepare(`DELETE FROM alert_rules WHERE id = ?`).run(id);
}

export function setAlertRuleEnabled(id: number, enabled: boolean): void {
  getDb().prepare(`UPDATE alert_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

/** Watchlist ticker symbols only (cheap — no per-row signal join). */
export function getWatchlistTickers(): string[] {
  const rows = getDb().prepare(`SELECT ticker FROM watchlist`).all() as { ticker: string }[];
  return rows.map((r) => r.ticker);
}

// ──────────────────────────────────────────────────────────────────────────
// Insider flow (sell-side intelligence) — per-ticker daily buy/sell dollar
// totals + Form 144 notice counts, keyed by source so cross-source sums never
// double-count (readers take the MAX per side across sources).
// ──────────────────────────────────────────────────────────────────────────

export interface InsiderFlowInput {
  ticker: string;
  flowDate: string; // YYYY-MM-DD
  buyValue: number;
  sellValue: number;
  form144Count: number;
  source: string;
}

export function upsertInsiderFlow(rows: InsiderFlowInput[]): void {
  if (!rows.length) return;
  const stmt = getDb().prepare(
    `INSERT INTO insider_flow (ticker, flow_date, source, buy_value, sell_value, form144_count, updated_at)
     VALUES (@ticker, @flow_date, @source, @buy_value, @sell_value, @form144_count, @updated_at)
     ON CONFLICT(ticker, flow_date, source) DO UPDATE SET
       buy_value = MAX(buy_value, excluded.buy_value),
       sell_value = MAX(sell_value, excluded.sell_value),
       form144_count = MAX(form144_count, excluded.form144_count),
       updated_at = excluded.updated_at`,
  );
  const now = new Date().toISOString();
  const tx = getDb().transaction((items: InsiderFlowInput[]) => {
    for (const r of items) {
      if (eventDate(r.flowDate).state !== 'valid' || ![r.buyValue,r.sellValue,r.form144Count].every(v => Number.isFinite(v) && v >= 0)) continue;
      stmt.run({
        ticker: r.ticker.toUpperCase(),
        flow_date: r.flowDate,
        source: r.source,
        buy_value: r.buyValue,
        sell_value: r.sellValue,
        form144_count: r.form144Count,
        updated_at: now,
      });
    }
  });
  tx(rows);
}

/** Replace only a fully traversed, stable source snapshot. History stays append-only. */
export function replaceInsiderSalesSnapshot(snapshot: {
  rows: InsiderFlowInput[]; complete: boolean; from: string; through: string; startedAt: string;
}): boolean {
  if (!snapshot.complete) return false;
  const source = 'openinsider-sales';
  const started = utcInstantMs(snapshot.startedAt);
  if (started === null || !snapshot.startedAt.includes('T') || started > Date.now() ||
      eventDate(snapshot.from).state !== 'valid' || eventDate(snapshot.through).state !== 'valid' || snapshot.from > snapshot.through) throw new Error('Invalid flow snapshot coverage');
  const keys = new Set<string>();
  for (const row of snapshot.rows) {
    const key = `${row.ticker.toUpperCase()}|${row.flowDate}`;
    if (keys.has(key) || row.source !== source || eventDate(row.flowDate).state !== 'valid' || row.flowDate < snapshot.from || row.flowDate > snapshot.through ||
        !row.ticker || !Number.isFinite(row.sellValue) || row.sellValue < 0 || row.buyValue !== 0 || row.form144Count !== 0) throw new Error('Invalid flow snapshot row');
    keys.add(key);
  }
  return getDb().transaction(() => {
    const previous = getDb().prepare('SELECT MAX(started_at) AS latest FROM insider_flow_snapshots WHERE source=?').get(source) as { latest: string | null };
    const canonicalTime = new Date(started).toISOString();
    if (previous.latest && canonicalTime <= previous.latest) return false;
    getDb().prepare('INSERT INTO insider_flow_snapshots(source,started_at,from_date,through_date,payload) VALUES(?,?,?,?,?)')
      .run(source,canonicalTime,snapshot.from,snapshot.through,JSON.stringify(snapshot.rows));
    // Missing rows in a proven complete snapshot mean zero, including an empty snapshot.
    getDb().prepare('UPDATE insider_flow SET sell_value=0, updated_at=? WHERE source=? AND flow_date>=? AND flow_date<=?')
      .run(canonicalTime,source,snapshot.from,snapshot.through);
    const insert = getDb().prepare(`INSERT INTO insider_flow(ticker,flow_date,source,buy_value,sell_value,form144_count,updated_at)
      VALUES(?,?,?,0,?,0,?) ON CONFLICT(ticker,flow_date,source) DO UPDATE SET sell_value=excluded.sell_value,updated_at=excluded.updated_at`);
    for (const row of snapshot.rows) insert.run(row.ticker.toUpperCase(),row.flowDate,source,row.sellValue,canonicalTime);
    return true;
  })();
}

export interface InsiderFlowSummary {
  buys: number;
  sells: number;
  form144: number;
  unresolvedBuys?: number;
  buyCoverage?: 'dated-records';
}

/**
 * Net insider flow over a trailing window. Different sources can report the
 * same underlying sales (feed overlap), so per side we take the MAX of the
 * per-source sums instead of adding sources together.
 */
export function getNetInsiderFlow(ticker: string, days = 90): InsiderFlowSummary {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT source, flow_date, sell_value AS s, form144_count AS f
       FROM insider_flow WHERE ticker = ? AND flow_date >= ?`,
    )
    .all(ticker.toUpperCase(), cutoff) as { source: string; flow_date: string; s: number | null; f: number | null }[];
  let buys = 0;
  let sells = 0;
  let form144 = 0;
  const bySource = new Map<string, { sells: number; form144: number }>();
  for (const row of rows) {
    if (eventDate(row.flow_date).state !== 'valid') continue;
    const total = bySource.get(row.source) ?? { sells: 0, form144: 0 };
    if (row.s !== null && Number.isFinite(row.s) && row.s > 0) total.sells += row.s;
    if (row.f !== null && Number.isFinite(row.f) && row.f > 0) total.form144 += row.f;
    bySource.set(row.source, total);
  }
  for (const total of bySource.values()) {
    sells = Math.max(sells, total.sells);
    form144 = Math.max(form144, total.form144);
  }
  buys = dedupTrades(getRecentInsiderTrades(days, ticker))
    .filter(t => admissibleTrade(t) && classifyTransaction(t.transactionType).modifier > 0)
    .reduce((sum,t) => sum + (sanitizeTradeAmounts(t.shares ?? 0, t.price, t.value ?? 0)?.value ?? 0), 0);
  const unresolvedBuys = getUnresolvedInsiderTrades(ticker).filter(t => classifyTransaction(t.transactionType).modifier > 0).length;
  return { buys, sells, form144, unresolvedBuys, buyCoverage: 'dated-records' };
}

// ──────────────────────────────────────────────────────────────────────────
// Persisted insider trades — the pipeline's memory (see the insider_trades DDL)
// ──────────────────────────────────────────────────────────────────────────

/** Write preference when two sources report the same trade. Lower wins. */
const TRADE_SOURCE_RANK: Record<string, number> = {
  edgar: 0,
  openinsider: 1,
  secform4: 2,
  // Curated/editorial feeds report rounded amounts and no transaction date, so
  // they must never overwrite a stored payload from a per-filing exact source.
  ceowatcher: 9,
};
const DEFAULT_TRADE_SOURCE_RANK = 5;

function tradeSourceRank(source: string): number {
  return TRADE_SOURCE_RANK[source] ?? DEFAULT_TRADE_SOURCE_RANK;
}

/**
 * Persist scraped trades. Idempotent: re-seeing a trade only refreshes
 * `last_seen`, and a more authoritative source overwrites the stored payload
 * (OpenInsider/EDGAR rows carry the filing + insider-history URLs that
 * aggregator rows lack). Returns how many were new.
 */
export function upsertInsiderTrades(trades: RawInsiderTrade[]): number {
  const stmt = getDb().prepare(`INSERT INTO insider_trades
    (ticker,insider_key,trade_date,value_cents,source,source_rank,payload,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(ticker,insider_key,trade_date,value_cents)
    DO UPDATE SET last_seen=excluded.last_seen`);
  let inserted = 0;
  getDb().transaction(() => {
    for (const t of trades) {
      if (!t.ticker || !t.insiderName || !Number.isFinite(t.value) || t.value < 0) continue;
      const now = new Date().toISOString();
      const dateStatus = t.dateStatus ?? eventDate(t.tradeDate).state;
      const payload: RawInsiderTrade = { ...t, ticker: t.ticker.toUpperCase(), dateStatus, observedAt: t.observedAt ?? now };
      recordTickerQuality(payload.ticker);
      const fingerprint = tradeFingerprint(payload);
      const key = `version:${fingerprint}`;
      const exists = getDb().prepare('SELECT 1 FROM insider_trades WHERE ticker=? AND insider_key=? AND trade_date=? AND value_cents=?').get(payload.ticker,key,payload.tradeDate || '',Math.round(payload.value*100));
      stmt.run(payload.ticker,key,payload.tradeDate || '',Math.round(payload.value*100),payload.source,tradeSourceRank(payload.source),JSON.stringify(payload),now,now);
      if (!exists) inserted++;
    }
  })();
  return inserted;
}

function isStoredTrade(value: unknown): value is RawInsiderTrade {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  if (!['ticker','insiderName','role','tradeDate','transactionType','source'].every(k => typeof t[k] === 'string')) return false;
  if (typeof t.value !== 'number' || !Number.isFinite(t.value) || t.value < 0 || typeof t.shares !== 'number' || !Number.isFinite(t.shares)) return false;
  if (t.reportingOwners !== undefined && (!Array.isArray(t.reportingOwners) || !t.reportingOwners.every(o => o && typeof o === 'object' && ['cik','name','role'].every(k => typeof o[k] === 'string')))) return false;
  if (t.filingRow !== undefined && (typeof t.filingRow !== 'number' || !Number.isInteger(t.filingRow) || t.filingRow < 0)) return false;
  return ['filingDate','transactionId','revisionOf','revisionAt','observedAt','sourceUrl','insiderUrl','filingAccession','issuerCik','originalSubmissionDate','securityTitle','ownershipNature'].every(k => t[k] === undefined || typeof t[k] === 'string');
}

function readCanonicalInsiderTrades(ticker?: string): RawInsiderTrade[] {
  const rows = (ticker ? getDb().prepare('SELECT payload FROM insider_trades WHERE ticker=?').all(ticker.toUpperCase()) :
    getDb().prepare('SELECT payload FROM insider_trades').all()) as { payload: string }[];
  const trades: RawInsiderTrade[] = [];
  for (const row of rows) {
    try {
      const t: unknown = JSON.parse(row.payload);
      if (isStoredTrade(t)) trades.push(t);
    } catch { /* Corrupt history is retained, but cannot authorize a live signal. */ }
  }
  // Suppress source shadows while quarantined/superseded SEC rows are still present.
  return dedupTrades(selectTradeRevisions(trades));
}

/** Unknown/invalid/conflicting rows remain inspectable, outside all verified windows. */
export function getUnresolvedInsiderTrades(ticker?: string): RawInsiderTrade[] {
  return readCanonicalInsiderTrades(ticker).filter(t => !admissibleTrade(t));
}

export function getRecentInsiderTrades(days = 30, ticker?: string): RawInsiderTrade[] {
  // Resolve versions BEFORE window filtering: a correction may move a trade outside it.
  return readCanonicalInsiderTrades(ticker).filter(t => admissibleTrade(t, days));
}

/**
 * One-time seed of `insider_trades` from the `signals` history, so the window is
 * populated on the first run after this table lands instead of starting empty
 * (which would leave every in-flight signal at score 0 until its trade happened
 * to be re-scraped). Idempotent — safe to call on every startup.
 */
export function backfillInsiderTradesFromSignals(days = 30): number {
  const existing = (
    getDb().prepare(`SELECT COUNT(*) AS n FROM insider_trades`).get() as { n: number }
  ).n;
  if (existing > 0) return 0; // already seeded — the live pipeline owns it from here
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT raw_trades FROM signals
       WHERE raw_trades IS NOT NULL AND raw_trades != '[]' AND trade_date >= ?`,
    )
    .all(cutoff) as { raw_trades: string }[];
  const trades: RawInsiderTrade[] = [];
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.raw_trades) as RawInsiderTrade[];
      if (Array.isArray(arr)) trades.push(...arr);
    } catch {
      /* skip unparseable history rows */
    }
  }
  const n = upsertInsiderTrades(trades);
  if (n > 0) console.log(`[db] backfilled ${n} insider trade(s) from signal history`);
  return n;
}


// ──────────────────────────────────────────────────────────────────────────
// Ticker meta cache (market cap / sector / earnings) — enrichment values change
// at most daily, so scrapes read this instead of re-fetching every ticker.
// ──────────────────────────────────────────────────────────────────────────

export interface TickerMeta {
  ticker: string;
  marketCap?: number;
  sector?: string;
  earningsDate?: string;
  earningsTiming?: string;
  shortPctFloat?: number;
  floatShares?: number;
  avgDollarVolume?: number;
  pctFrom52wHigh?: number;
  fetchedAt: string;
}

export function getTickerMeta(ticker: string, maxAgeMs: number): TickerMeta | null {
  const row = getDb()
    .prepare(`SELECT * FROM ticker_meta WHERE ticker = ?`)
    .get(ticker.toUpperCase()) as
    | {
        ticker: string;
        market_cap: number | null;
        sector: string | null;
        earnings_date: string | null;
        earnings_timing: string | null;
        short_pct_float: number | null;
        float_shares: number | null;
        avg_dollar_volume: number | null;
        pct_from_52w_high: number | null;
        fetched_at: string | null;
      }
    | undefined;
  if (!row?.fetched_at) return null;
  const at = Date.parse(row.fetched_at);
  if (Number.isNaN(at) || Date.now() - at > maxAgeMs) return null;
  return {
    ticker: row.ticker,
    marketCap: row.market_cap ?? undefined,
    sector: row.sector ?? undefined,
    earningsDate: row.earnings_date ?? undefined,
    earningsTiming: row.earnings_timing ?? undefined,
    shortPctFloat: row.short_pct_float ?? undefined,
    floatShares: row.float_shares ?? undefined,
    avgDollarVolume: row.avg_dollar_volume ?? undefined,
    pctFrom52wHigh: row.pct_from_52w_high ?? undefined,
    fetchedAt: row.fetched_at,
  };
}

export function upsertTickerMeta(meta: {
  ticker: string;
  marketCap?: number;
  sector?: string;
  earningsDate?: string;
  earningsTiming?: string;
  shortPctFloat?: number;
  floatShares?: number;
  avgDollarVolume?: number;
  pctFrom52wHigh?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO ticker_meta (ticker, market_cap, sector, earnings_date, earnings_timing, short_pct_float, float_shares, avg_dollar_volume, pct_from_52w_high, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         market_cap = excluded.market_cap,
         sector = excluded.sector,
         earnings_date = excluded.earnings_date,
         earnings_timing = excluded.earnings_timing,
         short_pct_float = excluded.short_pct_float,
         float_shares = excluded.float_shares,
         avg_dollar_volume = excluded.avg_dollar_volume,
         pct_from_52w_high = excluded.pct_from_52w_high,
         fetched_at = excluded.fetched_at`,
    )
    .run(
      meta.ticker.toUpperCase(),
      meta.marketCap ?? null,
      meta.sector ?? null,
      meta.earningsDate ?? null,
      meta.earningsTiming ?? null,
      meta.shortPctFloat ?? null,
      meta.floatShares ?? null,
      meta.avgDollarVolume ?? null,
      meta.pctFrom52wHigh ?? null,
      new Date().toISOString(),
    );
}

export function updateEarnings(
  ticker: string,
  earningsDate: string,
  earningsTiming: string | null,
  daysToEarnings: number | null,
): void {
  // Only the latest (current) signal row for the ticker — rewriting every
  // historical snapshot would corrupt the time-series (e.g. the score-trend chart).
  getDb()
    .prepare(
      `UPDATE signals
       SET earnings_date = ?, earnings_timing = ?, days_to_earnings = ?
       WHERE id = (SELECT id FROM signals WHERE ticker = ? ORDER BY scraped_at DESC, id DESC LIMIT 1)`,
    )
    .run(earningsDate, earningsTiming, daysToEarnings, ticker.toUpperCase());
}

/**
 * Bound the append-only history so a long-lived install doesn't grow forever.
 * Deletes signals/scrape logs older than `retentionDays` (default ~1 year, which
 * still leaves ample history for trend charts). Best-effort; called after a scrape.
 */
export function pruneOldData(retentionDays = 365): void {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const flowCutoff = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const tx = getDb().transaction(() => {
    getDb().prepare(`DELETE FROM signals WHERE scraped_at < ?`).run(cutoff);
    getDb().prepare(`DELETE FROM scrape_log WHERE started_at < ?`).run(cutoff);
    getDb().prepare(`DELETE FROM insider_flow WHERE flow_date < ?`).run(flowCutoff);
    // Immutable insider revision history is retained; readers apply the requested window.
    getDb().prepare(`DELETE FROM politician_trades WHERE trade_date < ?`).run(flowCutoff);
  });
  tx();
  // Checkpoint + truncate the WAL after the bulk delete, or the sidecar -wal
  // file grows unbounded on a long-lived install with a single connection.
  getDb().pragma('wal_checkpoint(TRUNCATE)');
}

// ──────────────────────────────────────────────────────────────────────────
// Testing portfolio (v1.4.0) — price cache, curve, trades, events, config
// ──────────────────────────────────────────────────────────────────────────

export interface PriceRow {
  ticker: string;
  date: string;
  adjClose: number;
}

/**
 * Write a freshly fetched series.
 *
 * REPLACE, not DO NOTHING: adjusted closes are restated for the WHOLE history
 * whenever a split or dividend happens, so keeping old rows and appending new
 * ones would weld a pre-split series onto a post-split one and manufacture a
 * −50% gap that trips every stop. A ticker's rows therefore always come from a
 * single fetch and are internally consistent.
 */
export function upsertPriceRows(rows: readonly PriceRow[]): number {
  if (!rows.length) return 0;
  const stmt = getDb().prepare(
    `INSERT INTO price_history (ticker, date, adj_close, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET adj_close = excluded.adj_close, fetched_at = excluded.fetched_at`,
  );
  const now = new Date().toISOString();
  const tx = getDb().transaction((batch: readonly PriceRow[]) => {
    for (const r of batch) stmt.run(r.ticker, r.date, r.adjClose, now);
  });
  tx(rows);
  return rows.length;
}

/** ticker → (date → adjusted close), from `date >= fromYmd`. */
export function getPriceBook(tickers: readonly string[], fromYmd: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!tickers.length) return out;
  const stmt = getDb().prepare(
    `SELECT date, adj_close FROM price_history WHERE ticker = ? AND date >= ? ORDER BY date`,
  );
  for (const t of tickers) {
    const rows = stmt.all(t, fromYmd) as { date: string; adj_close: number }[];
    if (!rows.length) continue;
    const series: Record<string, number> = {};
    for (const r of rows) series[r.date] = r.adj_close;
    out[t] = series;
  }
  return out;
}

/** Newest cached close per ticker plus when it was last fetched. */
export function getPriceCoverage(): Record<string, { last: string; n: number; fetchedAt: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT ticker, MAX(date) AS last, COUNT(*) AS n, MAX(fetched_at) AS fetchedAt
       FROM price_history GROUP BY ticker`,
    )
    .all() as { ticker: string; last: string; n: number; fetchedAt: string | null }[];
  const out: Record<string, { last: string; n: number; fetchedAt: string | null }> = {};
  for (const r of rows) out[r.ticker] = { last: r.last, n: r.n, fetchedAt: r.fetchedAt };
  return out;
}

/** Newest close in the whole cache — the "prices as of" stamp in the UI. */
export function getPriceAsOf(): string | null {
  const row = getDb().prepare(`SELECT MAX(date) AS d FROM price_history`).get() as { d: string | null } | undefined;
  return row?.d ?? null;
}

export interface PortfolioCandidateRow {
  ticker: string;
  score: number;
  /** ISO timestamp for `signals`, YYYY-MM-DD for `signal_outcomes`. */
  seenAt: string;
  signalId: number | null;
}

/**
 * Live candidates: the FIRST sighting of a ticker on a scrape day (MIN(id)), so
 * the score is the one that was actionable at that moment. Taking the day's max
 * would pick the best of N intraday scores after the fact — the same selection
 * bias `getOutcomeCandidates` and `computePerformanceReport` already guard against.
 */
export function getPortfolioSignalCandidates(minScore: number): PortfolioCandidateRow[] {
  return getDb()
    .prepare(
      `SELECT id AS signalId, ticker, score, scraped_at AS seenAt
       FROM signals
       WHERE id IN (SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY ticker, substr(scraped_at, 1, 10) ORDER BY scraped_at, id) AS rn
         FROM signals
       ) WHERE rn = 1)
         AND score >= ?
       ORDER BY scraped_at`,
    )
    .all(minScore) as PortfolioCandidateRow[];
}

/**
 * Backfill candidates from the labeled outcomes. These are real signals that
 * were measured at the time (score is never recomputed there), and they reach
 * five weeks further back than `signals`, whose rows rotate out.
 */
export function getPortfolioOutcomeCandidates(minScore: number): PortfolioCandidateRow[] {
  return getDb()
    .prepare(
      `SELECT ticker, MAX(score) AS score, entry_date AS seenAt, NULL AS signalId
       FROM signal_outcomes
       WHERE score >= ?
       GROUP BY ticker, entry_date
       ORDER BY entry_date`,
    )
    .all(minScore) as PortfolioCandidateRow[];
}

/** Every ticker that could ever qualify — the price-fetch worklist. */
export function getPortfolioUniverse(minScore: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT ticker FROM signals WHERE score >= ?
       UNION
       SELECT DISTINCT ticker FROM signal_outcomes WHERE score >= ?`,
    )
    .all(minScore, minScore) as { ticker: string }[];
  return rows.map((r) => r.ticker).sort();
}

/** Earliest date any candidate could have been acted on. */
export function getPortfolioHistoryStart(minScore: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT MIN(d) AS d FROM (
         SELECT MIN(substr(scraped_at, 1, 10)) AS d FROM signals WHERE score >= ?
         UNION ALL
         SELECT MIN(entry_date) AS d FROM signal_outcomes WHERE score >= ?
       )`,
    )
    .get(minScore, minScore) as { d: string | null } | undefined;
  return row?.d ?? null;
}

/** First day the LIVE `signals` table can speak for — the backfill/live border. */
export function getPortfolioLiveStart(): string | null {
  const row = getDb().prepare(`SELECT MIN(substr(scraped_at, 1, 10)) AS d FROM signals`).get() as
    | { d: string | null }
    | undefined;
  return row?.d ?? null;
}

// ── Curve ──

interface EquityRow {
  date: string;
  cash: number;
  spy_cash_value: number;
  positions_value: number;
  equity: number;
  equity_idle: number;
  benchmark: number;
  open_positions: number;
}

const toEquityPoint = (r: EquityRow): PortfolioEquityPoint => ({
  date: r.date,
  cash: r.cash,
  spyCashValue: r.spy_cash_value,
  positionsValue: r.positions_value,
  equity: r.equity,
  equityIdle: r.equity_idle,
  benchmark: r.benchmark,
  openPositions: r.open_positions,
});

export function getPortfolioEquity(): PortfolioEquityPoint[] {
  return (getDb().prepare(`SELECT * FROM portfolio_equity ORDER BY date`).all() as EquityRow[]).map(toEquityPoint);
}

/**
 * Append-only. A day that has already been written is NEVER rewritten, which is
 * what makes the published curve immutable: a later price restatement can change
 * what a re-simulation *would* produce, but it cannot retroactively move a point
 * a reader has already seen. Returns how many days were newly written.
 */
export function insertPortfolioEquity(points: readonly PortfolioEquityPoint[]): number {
  if (!points.length) return 0;
  const stmt = getDb().prepare(
    `INSERT INTO portfolio_equity (date, cash, spy_cash_value, positions_value, equity, equity_idle, benchmark, open_positions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO NOTHING`,
  );
  let written = 0;
  const tx = getDb().transaction((batch: readonly PortfolioEquityPoint[]) => {
    for (const p of batch) {
      written += stmt.run(
        p.date,
        p.cash,
        p.spyCashValue,
        p.positionsValue,
        p.equity,
        p.equityIdle,
        p.benchmark,
        p.openPositions,
      ).changes;
    }
  });
  tx(points);
  return written;
}

interface PositionRow {
  id: number;
  ticker: string;
  signal_id: number | null;
  entry_date: string;
  entry_price: number;
  shares: number;
  cost_basis: number;
  entry_score: number;
  target_weight: number;
  high_water_close: number | null;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  spy_entry: number | null;
  spy_exit: number | null;
}

/**
 * Drop the whole curve. Positions and events are REPLACEd on every sync anyway,
 * and `price_history` is an expensive cache that must survive — so this is the
 * curve alone, not `clearPortfolio()`'s full reset.
 *
 * Used when the config changes: rows simulated under different rules are not
 * the same curve, and appending to them produces a line no strategy ever
 * followed. The curve is fully derived from prices + candidates, both stored,
 * so throwing it away costs nothing but the rebuild.
 */
export function clearPortfolioEquity(): void {
  getDb().prepare(`DELETE FROM portfolio_equity`).run();
}

/**
 * Drop a single day, so a provisional (intraday) row can be recomputed by the
 * next run of the same day instead of being frozen by the append-only insert.
 */
export function deletePortfolioEquityDay(date: string): void {
  getDb().prepare(`DELETE FROM portfolio_equity WHERE date = ?`).run(date);
}

export function getPortfolioPositions(): PortfolioPosition[] {
  const rows = getDb()
    .prepare(`SELECT * FROM portfolio_positions ORDER BY entry_date, ticker`)
    .all() as PositionRow[];
  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    signalId: r.signal_id,
    entryDate: r.entry_date,
    entryPrice: r.entry_price,
    shares: r.shares,
    costBasis: r.cost_basis,
    entryScore: r.entry_score,
    targetWeight: r.target_weight,
    highWaterClose: r.high_water_close,
    exitDate: r.exit_date,
    exitPrice: r.exit_price,
    exitReason: (r.exit_reason as PortfolioPosition['exitReason']) ?? null,
    realizedPnl: r.realized_pnl,
    spyEntry: r.spy_entry,
    spyExit: r.spy_exit,
  }));
}

/**
 * Positions and events are a PROJECTION of the same deterministic simulation
 * the curve comes from, not an independent record, so they are rewritten whole
 * on every run. The curve itself stays append-only (see insertPortfolioEquity).
 */
export function replacePortfolioPositions(positions: readonly PortfolioPosition[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO portfolio_positions
       (ticker, signal_id, entry_date, entry_price, shares, cost_basis, entry_score, target_weight,
        high_water_close, exit_date, exit_price, exit_reason, realized_pnl, spy_entry, spy_exit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((batch: readonly PortfolioPosition[]) => {
    db.prepare(`DELETE FROM portfolio_positions`).run();
    for (const p of batch) {
      stmt.run(
        p.ticker,
        p.signalId,
        p.entryDate,
        p.entryPrice,
        p.shares,
        p.costBasis,
        p.entryScore,
        p.targetWeight,
        p.highWaterClose,
        p.exitDate,
        p.exitPrice,
        p.exitReason,
        p.realizedPnl,
        p.spyEntry,
        p.spyExit,
      );
    }
  });
  tx(positions);
}

export function getPortfolioEvents(limit = 500): PortfolioEvent[] {
  const rows = getDb()
    .prepare(`SELECT date, kind, ticker, score, amount, note FROM portfolio_events ORDER BY date DESC, id DESC LIMIT ?`)
    .all(limit) as { date: string; kind: string; ticker: string | null; score: number | null; amount: number | null; note: string | null }[];
  return rows.map((r) => ({
    date: r.date,
    kind: r.kind as PortfolioEvent['kind'],
    ticker: r.ticker,
    score: r.score,
    amount: r.amount,
    note: r.note,
  }));
}

/**
 * Replace the simulation-derived events. `suspect_price` rows are deliberately
 * spared: they record what a PRICE FETCH rejected, which no later simulation can
 * reproduce, and losing them would erase the only evidence that a bad data point
 * was caught rather than acted on.
 */
export function replacePortfolioEvents(events: readonly PortfolioEvent[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO portfolio_events (date, kind, ticker, score, amount, note) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((batch: readonly PortfolioEvent[]) => {
    db.prepare(`DELETE FROM portfolio_events WHERE kind <> 'suspect_price'`).run();
    for (const e of batch) stmt.run(e.date, e.kind, e.ticker, e.score, e.amount, e.note);
  });
  tx(events);
}

/** Append rejected price points, ignoring ones already recorded. */
export function insertPortfolioSuspectEvents(events: readonly PortfolioEvent[]): number {
  if (!events.length) return 0;
  const db = getDb();
  const known = new Set(
    (
      db
        .prepare(`SELECT date, ticker FROM portfolio_events WHERE kind = 'suspect_price'`)
        .all() as { date: string; ticker: string | null }[]
    ).map((r) => `${r.date}|${r.ticker ?? ''}`),
  );
  const stmt = db.prepare(
    `INSERT INTO portfolio_events (date, kind, ticker, score, amount, note) VALUES (?, 'suspect_price', ?, ?, ?, ?)`,
  );
  let n = 0;
  const tx = db.transaction((batch: readonly PortfolioEvent[]) => {
    for (const e of batch) {
      const key = `${e.date}|${e.ticker ?? ''}`;
      if (known.has(key)) continue;
      known.add(key);
      stmt.run(e.date, e.ticker, e.score, e.amount, e.note);
      n++;
    }
  });
  tx(events);
  return n;
}

/**
 * Full reset of the SIMULATION. `price_history`, `signals` and `signal_outcomes`
 * are deliberately untouched — the prices are an expensive, reusable cache and
 * the other two are the irreplaceable history the whole app is built on.
 */
export function clearPortfolio(): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM portfolio_equity`).run();
    db.prepare(`DELETE FROM portfolio_positions`).run();
    db.prepare(`DELETE FROM portfolio_events`).run();
  });
  tx();
}

// ── Config + run metadata (one JSON blob each, beside the app settings) ──

const PORTFOLIO_CONFIG_KEY = 'portfolio_config';
const PORTFOLIO_META_KEY = 'portfolio_meta';

export function getPortfolioConfig(): PortfolioConfig {
  const row = getDb().prepare(`SELECT value FROM app_settings WHERE key = ?`).get(PORTFOLIO_CONFIG_KEY) as
    | { value: string }
    | undefined;
  return { ...DEFAULT_PORTFOLIO_CONFIG, ...safeParse<Partial<PortfolioConfig>>(row?.value ?? null, {}) };
}

const PORTFOLIO_CONFIG_VERSION_KEY = 'portfolio_config_version';

/**
 * Reconcile an EXISTING runtime overlay with a change to the shipped defaults.
 *
 * `getPortfolioConfig` merges `app_settings.portfolio_config` OVER
 * `DEFAULT_PORTFOLIO_CONFIG`, and the rules editor writes the WHOLE merged
 * object back — so once anyone has opened that editor even to change the
 * starting cash, every exit rule is pinned in the database and a new constant
 * in `src/types` never reaches that installation. That is the entire reason
 * this function exists.
 *
 * What it does, once per version bump:
 *   - a stored exit value that still equals the v1 default is DELETED from the
 *     overlay, so the new default shows through (and so will the next one);
 *   - a stored exit value that differs is a deliberate choice and is KEPT.
 *
 * Deleting rather than overwriting is the point: the overlay ends up holding
 * only what the user actually decided.
 */
export function migratePortfolioConfig(): { migrated: string[]; kept: string[] } | null {
  const db = getDb();
  const versionRow = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(PORTFOLIO_CONFIG_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (Number(versionRow?.value) >= PORTFOLIO_CONFIG_VERSION) return null;

  const stamp = (): void => {
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(PORTFOLIO_CONFIG_VERSION_KEY, String(PORTFOLIO_CONFIG_VERSION));
  };

  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(PORTFOLIO_CONFIG_KEY) as
    | { value: string }
    | undefined;
  const stored = safeParse<Record<string, unknown> | null>(row?.value ?? null, null);
  if (!stored) {
    // Nothing has ever been overridden — the new defaults already apply.
    stamp();
    return { migrated: [], kept: [] };
  }

  const migrated: string[] = [];
  const kept: string[] = [];
  for (const [key, superseded] of Object.entries(PORTFOLIO_SUPERSEDED_DEFAULTS)) {
    if (!(key in stored)) continue;
    if (superseded.includes(stored[key])) {
      delete stored[key];
      migrated.push(key);
    } else {
      kept.push(key);
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(PORTFOLIO_CONFIG_KEY, JSON.stringify(stored));
    stamp();
  });
  tx();
  return { migrated, kept };
}

export function setPortfolioConfig(partial: Partial<PortfolioConfig>): PortfolioConfig {
  const merged: PortfolioConfig = { ...getPortfolioConfig(), ...partial };
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(PORTFOLIO_CONFIG_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * The parameter set the STORED curve was built with, plus the run counters.
 * Persisted next to the curve so a chart can never display parameters it was
 * not computed with.
 */
export interface PortfolioRunMeta {
  config: PortfolioConfig;
  /**
   * Which builder produced the stored curve. Absent on curves written before
   * this existed, which is exactly the signal that they need rebuilding — see
   * CURVE_BUILDER_VERSION in `portfolio.ts`.
   */
  curveVersion?: number;
  builtAt: string;
  backfillStart: string | null;
  liveStart: string | null;
  skippedNoCash: number;
  skippedCap: number;
  missingPrices: number;
  suspectPrices: number;
  untradableTickers: string[];
  restatedDays: number;
}

export function getPortfolioRunMeta(): PortfolioRunMeta | null {
  const row = getDb().prepare(`SELECT value FROM app_settings WHERE key = ?`).get(PORTFOLIO_META_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return null;
  const parsed = safeParse<PortfolioRunMeta | null>(row.value, null);
  return parsed && parsed.config ? parsed : null;
}

export function setPortfolioRunMeta(meta: PortfolioRunMeta): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(PORTFOLIO_META_KEY, JSON.stringify(meta));
}


/** Independent snapshot, included in normal SQLite history backups. */
export function getPortfolioExperiment(id: string): PortfolioExperiment | null {
  const row = getDb().prepare('SELECT state_json FROM portfolio_experiments WHERE id = ?').get(id) as { state_json: string } | undefined;
  return row ? safeParse<PortfolioExperiment | null>(row.state_json, null) : null;
}

export function setPortfolioExperiment(experiment: PortfolioExperiment): void {
  getDb().prepare('INSERT INTO portfolio_experiments(id, state_json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json')
    .run(experiment.id, JSON.stringify(experiment));
}

/** Keep the first observed candidate when rolling source rows are pruned. */
export function archiveExperimentCandidates(id: string, candidates: PortfolioCandidate[]): PortfolioCandidate[] {
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO portfolio_experiment_candidates VALUES(?, ?, ?, ?)');
  db.transaction(() => {
    for (const c of [...candidates].sort((a,b) => a.earliestDate.localeCompare(b.earliestDate) || (Number(b.source === 'signal') - Number(a.source === 'signal')))) {
      insert.run(id, c.ticker, c.earliestDate, JSON.stringify(c));
    }
  })();
  const rows = db.prepare('SELECT candidate_json FROM portfolio_experiment_candidates WHERE experiment_id = ? ORDER BY earliest_date, ticker').all(id) as { candidate_json: string }[];
  return rows.map((r) => JSON.parse(r.candidate_json) as PortfolioCandidate);
}

/** Additive quarantine: original signals, labels and trade payloads stay intact. */
export function recordTickerQuality(ticker: string): void {
  ticker = ticker ?? '';
  const reason = tickerIssue(ticker);
  if (!reason) return;
  getDb().prepare(`INSERT INTO ticker_quarantine VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET reason=excluded.reason, last_seen=excluded.last_seen`).run(ticker, reason);
}

function quarantineLegacyTickers(): void {
  const rows = getDb().prepare(`SELECT ticker FROM signals UNION SELECT ticker FROM signal_outcomes UNION SELECT ticker FROM insider_trades`).all() as { ticker: string }[];
  getDb().transaction(() => { for (const row of rows) recordTickerQuality(row.ticker); })();
}

export function archivePortfolioRevision(reason: string, state: unknown): void {
  getDb().prepare("INSERT OR IGNORE INTO portfolio_revisions VALUES (?, datetime('now'), ?)").run(reason, JSON.stringify(state));
}
