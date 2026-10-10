import Database from 'better-sqlite3';
import { SCHEMA, runMigrations } from './database';

/** Public evidence is additive. Local IDs and private settings never travel. */
export const HISTORY_TABLES: { table: string; identity: string[] }[] = [
  ...['decisions', 'purchases', 'trades', 'closures', 'analyses', 'replays'].map(name => ({ table: `backtest_${name}`, identity: ['key'] })),
  { table: 'signals', identity: ['ticker', 'scraped_at'] },
  { table: 'scrape_log', identity: ['started_at'] },
  { table: 'insider_trades', identity: ['ticker', 'insider_key', 'trade_date', 'value_cents'] },
  { table: 'signal_outcomes', identity: ['ticker', 'entry_date', 'horizon'] },
  { table: 'price_history', identity: ['ticker', 'date'] },
  { table: 'portfolio_experiment_candidates', identity: ['experiment_id', 'ticker', 'earliest_date'] },
];
const BOOK_TABLES = ['portfolio_positions', 'portfolio_equity', 'portfolio_events', 'portfolio_experiments'];
const BOOK_KEYS = ['portfolio_config', 'portfolio_meta', 'portfolio_config_version', 'shared_portfolio_state', 'shared_backtest_state'];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function columns(db: Database.Database, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as { name: string }[]).map(r => r.name);
}
function copy(db: Database.Database, table: string, identity?: string[]): number {
  const source = columns(db, 'incoming', table);
  if (!source.length) return 0; // exports from older versions
  const cols = columns(db, 'main', table).filter(c => c !== 'id' && source.includes(c));
  if (!cols.length || identity?.some(c => !cols.includes(c))) throw new Error(`Incompatible shared table: ${table}`);
  // signal_id refers to a machine-local autoincrement key, never to the same
  // signal on another machine. Historical decision evidence has its own key.
  const selected = cols.map(c => c === 'signal_id' ? 'NULL' : `s.${quote(c)}`).join(',');
  const match = identity ? `WHERE NOT EXISTS (SELECT 1 FROM main.${quote(table)} t WHERE ${identity.map(c => `t.${quote(c)} IS s.${quote(c)}`).join(' AND ')})` : '';
  const group = identity ? `GROUP BY ${identity.map(c => `s.${quote(c)}`).join(',')}` : '';
  return db.prepare(`INSERT INTO main.${quote(table)} (${cols.map(quote).join(',')}) SELECT ${selected} FROM incoming.${quote(table)} s ${match} ${group}`).run().changes;
}

/** Read the source, verify, and commit all evidence and the canonical book together. */
export function mergeSharedHistory(db: Database.Database, source: string, revision?: string): Record<string, number> {
  db.prepare('ATTACH DATABASE ? AS incoming').run(source);
  try {
    const check = db.prepare('PRAGMA incoming.quick_check').all() as { quick_check: string }[];
    if (check.some(r => r.quick_check !== 'ok')) throw new Error('Shared history integrity check failed');
    return db.transaction(() => {
      const copied: Record<string, number> = {};
      for (const spec of HISTORY_TABLES) copied[spec.table] = copy(db, spec.table, spec.identity);
      // Prices are a mutable cache, unlike historical decision evidence. Only
      // a later successful observation may restate an existing cached close.
      if (columns(db, 'incoming', 'price_history').includes('fetched_at')) {
        copied.price_history += db.prepare(`UPDATE main.price_history AS t SET
          adj_close = s.adj_close, fetched_at = s.fetched_at
          FROM incoming.price_history AS s WHERE t.ticker = s.ticker AND t.date = s.date
          AND julianday(s.fetched_at) > COALESCE(julianday(t.fetched_at), 0)
          AND s.adj_close > 0`).run().changes;
      }
      if (revision) {
        const previous = db.prepare("SELECT value FROM app_settings WHERE key = 'web_sync_revision'").get() as { value: string } | undefined;
        if (previous && previous.value >= revision) return copied;
        // The cloud owns the simulated book; preserve the previous local book
        // as a recovery revision instead of adding cash/positions twice.
        const archive = Object.fromEntries(BOOK_TABLES.map(t => [t, db.prepare(`SELECT * FROM ${quote(t)}`).all()]));
        archive.app_settings = db.prepare(`SELECT * FROM app_settings WHERE key IN (${BOOK_KEYS.map(() => '?').join(',')})`).all(...BOOK_KEYS);
        db.prepare('INSERT OR IGNORE INTO portfolio_revisions(reason,saved_at,state_json) VALUES(?,?,?)').run(`before-web-sync:${revision}`, new Date().toISOString(), JSON.stringify(archive));
        for (const table of BOOK_TABLES) {
          if (!columns(db, 'incoming', table).length) throw new Error(`Missing shared book: ${table}`);
          db.prepare(`DELETE FROM ${quote(table)}`).run();
          copied[table] = copy(db, table);
        }
        const read = db.prepare('SELECT value FROM incoming.app_settings WHERE key = ?');
        const write = db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
        for (const key of BOOK_KEYS) {
          const row = read.get(key) as { value: string } | undefined;
          if (row) write.run(key, row.value);
          else db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        }
        write.run('web_sync_revision', revision);
      }
      return copied;
    })();
  } finally { db.exec('DETACH DATABASE incoming'); }
}

export function exportSharedHistory(source: string, destination: string, publishedPortfolio?: unknown, publishedBacktest?: unknown): void {
  const db = new Database(destination);
  try {
    db.exec(SCHEMA);
    runMigrations(db);
    mergeSharedHistory(db, source);
    db.prepare('ATTACH DATABASE ? AS incoming').run(source);
    try {
      db.transaction(() => {
        for (const table of BOOK_TABLES) copy(db, table);
        const read = db.prepare('SELECT value FROM incoming.app_settings WHERE key = ?');
        for (const key of BOOK_KEYS) {
          const row = read.get(key) as { value: string } | undefined;
          if (row) db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(key, row.value);
        }
        if (publishedPortfolio) db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('shared_portfolio_state', JSON.stringify(publishedPortfolio));
        if (publishedBacktest) db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('shared_backtest_state', JSON.stringify(publishedBacktest));
      })();
    } finally { db.exec('DETACH DATABASE incoming'); }
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
}
