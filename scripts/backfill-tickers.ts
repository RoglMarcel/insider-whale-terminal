/**
 * One-time backfill: repair doubled-letter tickers ALREADY STORED in the DB.
 *
 *   npm run backfill:tickers            # dry run — prints every proposed change
 *   npm run backfill:tickers -- --apply # writes, after taking a backup
 *
 * WHY THIS IS NEEDED
 *
 * `sanitizeTickerRows` repairs tickers at SCRAPE time. It never touches rows
 * that are already in the database. Those rows keep producing aggregates on
 * every run — which is why the live site still showed `IINTC`, `AALK`, `IINV`
 * after the repair shipped: the corrupt rows came from earlier Finviz runs and
 * were being re-aggregated and re-published with a fresh `scraped_at`. Waiting
 * for the 30-day retention to expire means a month of wrong symbols in public.
 *
 * WHY IT IS SAFE
 *
 * `repairDoubledTicker` only rewrites a symbol when the stored one is NOT in the
 * SEC registry AND the de-doubled form IS. So `AAT`, `QQQ`, `LLY`, `BBW` and
 * every other legitimately doubled ticker are provably untouched — the guard is
 * the same one the scrape path uses and is unit-tested.
 *
 * The registry is the whole safety argument, so an empty registry ABORTS rather
 * than quietly doing nothing: a silent no-op is exactly how this defect stayed
 * invisible in CI.
 *
 * COLLISIONS
 *
 * `insider_trades` is keyed by (ticker, insider_key, trade_date, value_cents).
 * When the same trade was recorded under BOTH the corrupt and the correct
 * symbol, renaming would collide — those rows are provable duplicates and are
 * deleted instead. `signal_outcomes` is deliberately left alone: it is a frozen
 * record of what was scored at the time, and its primary key would collide too.
 */
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../electron/database';
import { repairDoubledTicker, canonicalTicker } from '../electron/scraper/util';
import { getRegisteredTickers } from '../electron/scraper/sellside';

const APPLY = process.argv.includes('--apply');

interface Change {
  from: string;
  to: string;
  trades: number;
  signals: number;
  outcomes: number;
}

async function main(): Promise<number> {
  const dbPath = process.env.DB_PATH?.trim() || path.resolve(process.cwd(), 'data', 'insider-tracker.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`Keine DB unter ${dbPath}.`);
    return 1;
  }

  console.log('Lade SEC-Symbolregister…');
  const registered = await getRegisteredTickers();
  if (registered.size === 0) {
    console.error(
      'ABBRUCH: das SEC-Register ist leer. Ohne Register ist jede Reparatur ungeprüft —\n' +
        'und ein stiller No-op ist genau der Fehler, den dieses Skript beheben soll.',
    );
    return 1;
  }
  console.log(`Register: ${registered.size} Symbole.`);
  const isRegistered = (t: string) => registered.has(t);

  const db = initDatabase(dbPath);

  /**
   * Candidate symbols come from the indexed COLUMNS *and* from the JSON blobs.
   * Scanning only the columns is what made the first version of this script
   * look successful while changing nothing: the pipeline reads the blobs, so a
   * clean column with a stale payload still rebuilds the corrupt aggregate on
   * the next run — and a re-run would then report "nothing to repair".
   */
  const candidates = new Set<string>();
  for (const t of ['insider_trades', 'signals']) {
    for (const r of db.prepare(`SELECT DISTINCT ticker FROM ${t} WHERE ticker IS NOT NULL`).all() as { ticker: string }[]) {
      candidates.add(r.ticker);
    }
  }
  const harvest = (sql: string, isArray: boolean) => {
    for (const r of db.prepare(sql).all() as { blob: string }[]) {
      try {
        const parsed = JSON.parse(r.blob) as unknown;
        const items = isArray ? (Array.isArray(parsed) ? parsed : []) : [parsed];
        for (const it of items) {
          const tk = (it as { ticker?: unknown } | null)?.ticker;
          if (typeof tk === 'string' && tk) candidates.add(tk);
        }
      } catch {
        /* ignore unparseable blobs */
      }
    }
  };
  harvest(`SELECT payload AS blob FROM insider_trades WHERE payload IS NOT NULL`, false);
  harvest(`SELECT raw_trades AS blob FROM signals WHERE raw_trades IS NOT NULL`, true);
  harvest(`SELECT options_activity AS blob FROM signals WHERE options_activity IS NOT NULL`, true);

  const distinct = [...candidates].map((ticker) => ({ ticker }));

  const changes: Change[] = [];
  for (const { ticker } of distinct) {
    if (!ticker) continue;
    const canon = canonicalTicker(ticker);
    const repaired = repairDoubledTicker(ticker, isRegistered);
    // `repairDoubledTicker` also CANONICALIZES (`BRK-A` → `BRK.A`), and a bare
    // canonicalization is not this script's business: renaming `BRK-A` in
    // `signals` while `signal_outcomes` keeps the old spelling would
    // desynchronize the labeled history, and rewriting junk like
    // `3.MONTHMATURE` accomplishes nothing. Restrict to a genuine de-doubling,
    // and assert that shape explicitly rather than trusting the difference.
    if (repaired === canon) continue;
    if (repaired !== canon.slice(1)) {
      console.warn(`  übersprungen (unerwartete Form): ${ticker} → ${repaired}`);
      continue;
    }
    const count = (sql: string) => (db.prepare(sql).get(ticker) as { c: number }).c;
    changes.push({
      from: ticker,
      to: repaired,
      trades: count(`SELECT COUNT(*) c FROM insider_trades WHERE ticker = ?`),
      signals: count(`SELECT COUNT(*) c FROM signals WHERE ticker = ?`),
      outcomes: count(`SELECT COUNT(*) c FROM signal_outcomes WHERE ticker = ?`),
    });
  }

  changes.sort((a, b) => b.trades + b.signals - (a.trades + a.signals));

  if (!changes.length) {
    console.log('Nichts zu reparieren.');
    closeDatabase();
    return 0;
  }

  console.log(`\n${changes.length} Symbole werden repariert:\n`);
  console.log('  von        → nach       insider_trades   signals   (signal_outcomes, unberührt)');
  for (const c of changes) {
    console.log(
      `  ${c.from.padEnd(10)} → ${c.to.padEnd(10)} ${String(c.trades).padStart(11)} ${String(c.signals).padStart(9)} ${String(c.outcomes).padStart(20)}`,
    );
  }
  const tot = changes.reduce(
    (a, c) => ({ trades: a.trades + c.trades, signals: a.signals + c.signals, outcomes: a.outcomes + c.outcomes }),
    { trades: 0, signals: 0, outcomes: 0 },
  );
  console.log(`\n  Summe: ${tot.trades} insider_trades · ${tot.signals} signals · ${tot.outcomes} signal_outcomes bleiben unangetastet.`);

  // Duplicate detection: the same trade stored under both symbols.
  const dupStmt = db.prepare(
    `SELECT COUNT(*) c FROM insider_trades b
      WHERE b.ticker = ?
        AND EXISTS (SELECT 1 FROM insider_trades g
                     WHERE g.ticker = ?
                       AND g.insider_key = b.insider_key
                       AND g.trade_date  = b.trade_date
                       AND g.value_cents = b.value_cents)`,
  );
  let dupTotal = 0;
  for (const c of changes) dupTotal += (dupStmt.get(c.from, c.to) as { c: number }).c;
  console.log(`  Davon nachweisliche Duplikate (existieren bereits unter dem korrekten Symbol): ${dupTotal} — werden gelöscht, nicht umbenannt.`);

  if (!APPLY) {
    console.log('\nDRY RUN — nichts geschrieben. Mit `-- --apply` ausführen, um zu schreiben.');
    closeDatabase();
    return 0;
  }

  // Backup before the first write (Regel 6 des Audit-Auftrags).
  const backupDir = path.resolve(process.cwd(), 'tmp', 'backfill');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `insider-tracker.pre-backfill.${Date.now()}.db`);
  fs.copyFileSync(dbPath, backup);
  console.log(`\nBackup: ${path.relative(process.cwd(), backup)}`);

  const delDup = db.prepare(
    `DELETE FROM insider_trades
      WHERE ticker = ?
        AND EXISTS (SELECT 1 FROM insider_trades g
                     WHERE g.ticker = ?
                       AND g.insider_key = insider_trades.insider_key
                       AND g.trade_date  = insider_trades.trade_date
                       AND g.value_cents = insider_trades.value_cents)`,
  );
  const updTrades = db.prepare(`UPDATE insider_trades SET ticker = ? WHERE ticker = ?`);
  const updSignals = db.prepare(`UPDATE signals SET ticker = ? WHERE ticker = ?`);

  /**
   * The ticker is DENORMALIZED into JSON blobs, and those blobs — not the
   * indexed column — are what the pipeline actually reads back:
   * `getRecentInsiderTrades` selects `payload` and regroups aggregates by the
   * ticker INSIDE it. Repairing only the column therefore looks correct in the
   * table and changes nothing about what gets published: the next run rebuilds
   * the corrupt aggregate from the stale payload. Rewrite the blobs too.
   *
   * Done by parsing rather than string-replacing, so a symbol appearing in some
   * other field (an insider's name, a URL) can never be corrupted.
   */
  const map = new Map(changes.map((c) => [c.from, c.to]));
  const fixTicker = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    const o = v as { ticker?: unknown };
    if (typeof o.ticker === 'string' && map.has(o.ticker)) {
      o.ticker = map.get(o.ticker);
      return true;
    }
    return false;
  };
  const fixJsonColumn = (table: string, idCol: string, col: string, isArray: boolean): number => {
    const rows = db.prepare(`SELECT ${idCol} AS id, ${col} AS blob FROM ${table} WHERE ${col} IS NOT NULL`).all() as {
      id: number;
      blob: string;
    }[];
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${idCol} = ?`);
    let n = 0;
    for (const r of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.blob);
      } catch {
        continue; // a corrupt blob must not take the backfill down
      }
      let touched = false;
      if (isArray && Array.isArray(parsed)) {
        for (const item of parsed) touched = fixTicker(item) || touched;
      } else {
        touched = fixTicker(parsed);
      }
      if (touched) {
        upd.run(JSON.stringify(parsed), r.id);
        n++;
      }
    }
    return n;
  };

  let deleted = 0;
  let renamedTrades = 0;
  let renamedSignals = 0;
  let payloadTrades = 0;
  let payloadSignals = 0;
  let payloadOptions = 0;
  db.transaction(() => {
    for (const c of changes) {
      deleted += delDup.run(c.from, c.to).changes;
      renamedTrades += updTrades.run(c.to, c.from).changes;
      renamedSignals += updSignals.run(c.to, c.from).changes;
    }
    payloadTrades = fixJsonColumn('insider_trades', 'rowid', 'payload', false);
    payloadSignals = fixJsonColumn('signals', 'id', 'raw_trades', true);
    payloadOptions = fixJsonColumn('signals', 'id', 'options_activity', true);
  })();

  console.log(
    `\nGeschrieben: ${deleted} Duplikate gelöscht · ${renamedTrades} insider_trades umbenannt · ${renamedSignals} signals umbenannt.`,
  );
  console.log(
    `JSON-Blobs korrigiert: ${payloadTrades} insider_trades.payload · ${payloadSignals} signals.raw_trades · ${payloadOptions} signals.options_activity.`,
  );

  const left = (db
    .prepare(`SELECT COUNT(DISTINCT ticker) c FROM insider_trades WHERE ticker GLOB '[A-Z][A-Z]*'`)
    .get() as { c: number }).c;
  console.log(`Kontrolle: ${left} verschiedene Ticker in insider_trades (Doppelbuchstaben-Prüfung erfolgt beim nächsten Lauf erneut).`);

  closeDatabase();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
