import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageDesktopSnapshot, DESKTOP_SNAPSHOT_PATH } from './desktopSnapshot';
import { SCHEMA, runMigrations, snapshotDatabase } from './database';

/**
 * Export only public signal/trade tables into bounded, checksummed Git chunks.
 * The cloud merges them into its durable history; desktop never replaces it.
 * Existing Git credentials suffice. Failures are reported without failing the scrape.
 */

/** CI greps the commit subject for this to take the no-scrape fast path. */
export const DESKTOP_PUBLISH_MARKER = '[desktop-publish]';

/** Tables copied to the repo DB, and the key that makes each copy idempotent. */
const COPIED_TABLES: { table: string; identity: string[] }[] = [
  { table: 'backtest_decisions', identity: ['key'] },
  { table: 'backtest_purchases', identity: ['key'] },
  { table: 'backtest_trades', identity: ['key'] },
  { table: 'backtest_closures', identity: ['key'] },
  { table: 'backtest_analyses', identity: ['key'] },
  { table: 'backtest_replays', identity: ['key'] },
  // The alerts themselves — this is what the web terminal renders.
  { table: 'signals', identity: ['ticker', 'scraped_at'] },
  // Session list behind the web UI's run history + source-health panel.
  { table: 'scrape_log', identity: ['started_at'] },
  // The pipeline's trade memory, so a later cloud run inherits the window this
  // machine built rather than restarting from its own 14-day source horizon.
  { table: 'insider_trades', identity: ['ticker', 'insider_key', 'trade_date', 'value_cents'] },
];

const GIT_TIMEOUT_MS = 120_000;
/** Publish signals at least this fresh. Matches the web's active-signal window. */
const DEFAULT_SINCE_MS = 7 * 86_400_000;

export interface WebPublishResult {
  ok: boolean;
  /** Set when publishing deliberately did nothing (disabled, no repo, no changes). */
  skipped?: string;
  copied?: Record<string, number>;
  pushed?: boolean;
  error?: string;
}

// Single-flight: the scheduler and a manual scrape can finish close together,
// and two concurrent git pushes on one checkout corrupt each other's index.
let publishInFlight = false;

function git(repo: string, args: string[]): string {
  try { return execFileSync('git', args, {
    cwd: repo,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }); } catch {
    // Git stderr can include credential-bearing remote URLs. Never send it to
    // the renderer or logs; the operation is enough to diagnose the failure.
    throw new Error(`Web publication: git ${args[0]} failed. Check repository access and Git credentials.`);
  }
}

/**
 * Locate the repo checkout that backs the website. The packaged desktop app
 * runs from Program Files and has no relationship to the repo, so this is a
 * user setting; `process.cwd()` only resolves it when running from source.
 */
export function resolveRepoPath(configured?: string): { path: string } | { error: string } {
  const isCheckout = (dir: string) =>
    fs.existsSync(path.join(dir, '.git')) && fs.existsSync(path.join(dir, 'package.json'));

  // An explicitly configured path that does not resolve is an ERROR, never a
  // reason to fall back to the working directory: falling back would quietly
  // publish into whatever checkout the app happens to be running from, which is
  // both wrong and invisible. Only an unset path may fall back.
  if (configured && configured.trim()) {
    const repo = path.resolve(configured.trim());
    if (isCheckout(repo)) return { path: repo };
    return { error: `Configured repo path is not a git checkout: ${repo}` };
  }
  const cwd = path.resolve(process.cwd());
  if (isCheckout(cwd)) return { path: cwd };
  return {
    error:
      'No repo path configured (Settings → Web publish) and the working directory is not a git checkout.',
  };
}

/**
 * Column names a table actually has. `schema` must be passed separately: the
 * schema-qualified PRAGMA form is `PRAGMA <schema>.table_info(<table>)` —
 * writing `PRAGMA table_info(src.signals)` parses but matches nothing, which
 * silently yields an empty column list and copies zero rows.
 */
function columnsOf(db: Database.Database, schema: string, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA "${schema}".table_info("${table}")`).all() as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Copy one table from the attached snapshot. Columns are intersected between the
 * two files so a repo DB on an older migration still receives what it can hold,
 * and `id` is dropped so the target assigns its own primary keys.
 */
function copyTable(
  target: Database.Database,
  table: string,
  identity: string[],
  sinceIso: string,
): number {
  const targetCols = columnsOf(target, 'main', table);
  const sourceCols = columnsOf(target, 'src', table);
  if (!sourceCols.length && table.startsWith('backtest_')) return 0; // older desktop export
  if (!targetCols.length || !sourceCols.length) throw new Error(`Missing export table: ${table}`);
  const cols = targetCols.filter((c) => c !== 'id' && sourceCols.includes(c));
  if (!identity.every((c) => cols.includes(c))) throw new Error(`Missing identity columns: ${table}`);

  const list = cols.map((c) => `"${c}"`).join(', ');
  // Idempotency: re-publishing the same run must not duplicate rows, and the
  // identity columns are what make a row the same row across the two files.
  // `IS` rather than `=` so a NULL on both sides still counts as a match.
  const notExists = identity.every((c) => cols.includes(c))
    ? `AND NOT EXISTS (SELECT 1 FROM main."${table}" t WHERE ${identity
        .map((c) => `t."${c}" IS s."${c}"`)
        .join(' AND ')})`
    : '';
  // Only `signals` carries scraped_at. Binding @since for a statement that does
  // not reference it makes better-sqlite3 throw on the unused parameter, so the
  // filter and the binding have to be decided together.
  const hasTime = cols.includes('scraped_at');
  const timeFilter = hasTime ? 'AND s."scraped_at" >= @since' : '';

  const sql = `INSERT INTO main."${table}" (${list})
               SELECT ${cols.map((c) => `s."${c}"`).join(', ')}
               FROM src."${table}" s
               WHERE 1=1 ${timeFilter} ${notExists}`;
  const info = hasTime ? target.prepare(sql).run({ since: sinceIso }) : target.prepare(sql).run();
  return info.changes;
}

export interface PublishOptions {
  /** Repo checkout from settings; falls back to cwd when running from source. */
  repoPath?: string;
  /** Only copy signals at least this fresh. Defaults to the last 7 days. */
  sinceIso?: string;
  /** When false, write the repo DB but leave pushing to the user. */
  push?: boolean;
  /**
   * Publish from this file instead of a live snapshot of the app's DB. For the CLI after closing its database and for tests. Live desktop databases
   * must use snapshotDatabase so WAL-resident rows are included.
   */
  sourceDbPathForTest?: string;
}

export async function publishToWeb(opts: PublishOptions = {}): Promise<WebPublishResult> {
  if (publishInFlight) return { ok: false, skipped: 'another publish is already running' };
  publishInFlight = true;
  let target: Database.Database | null = null;
  let tmpDir: string | null = null;
  try {
    const resolved = resolveRepoPath(opts.repoPath);
    if ('error' in resolved) return { ok: false, skipped: resolved.error };
    const sourceRepo = resolved.path;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwt-publish-'));
    let repo = sourceRepo;
    const repoDbPath = path.join(tmpDir, 'export.db');

    // Snapshot the live DB rather than attaching it: publishing runs moments
    // after a scrape, when the newest rows are still in the -wal sidecar, and
    // attaching the app's own open file would add a second writer to it.
    let sourcePath: string;
    if (opts.sourceDbPathForTest) {
      sourcePath = opts.sourceDbPathForTest;
      if (!fs.existsSync(sourcePath)) return { ok: false, skipped: `source DB not found: ${sourcePath}` };
    } else {
      sourcePath = path.join(tmpDir, 'snapshot.db');
      await snapshotDatabase(sourcePath);
    }

    // The configured directory supplies credentials/remote identity only. A
    // downloaded source ZIP over an old checkout is not a mergeable branch.
    // Publish from a disposable clone, preserving every local file and index.
    if (opts.push !== false) {
      const remote = git(sourceRepo, ['remote', 'get-url', '--push', 'origin']).trim();
      repo = path.join(tmpDir, 'delivery');
      git(sourceRepo, ['clone', '--quiet', '--depth', '1', '--branch', 'main', '--', remote, repo]);
      for (const key of ['user.name', 'user.email']) {
        git(repo, ['config', key, git(sourceRepo, ['config', '--get', key]).trim()]);
      }
    }

    target = new Database(repoDbPath);
    target.pragma('journal_mode = WAL');
    // The repo DB may predate the newest migration (it is written by whichever
    // side ran last), so bring it up to date before naming any column.
    target.exec(SCHEMA);
    runMigrations(target);

    const since = opts.sinceIso ?? new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();
    target.prepare('ATTACH DATABASE ? AS src').run(sourcePath);
    const copied: Record<string, number> = {};
    try {
      const tx = target.transaction(() => {
        for (const { table, identity } of COPIED_TABLES) {
          // A partial export must not be reported as successful.
          copied[table] = copyTable(target as Database.Database, table, identity, since);
        }
      });
      tx();
    } finally {
      try {
        target.exec('DETACH DATABASE src');
      } catch {
        /* already detached */
      }
    }
    // Close/checkpoint the export before compressing it; no WAL sidecar travels.
    target.pragma('wal_checkpoint(TRUNCATE)');
    target.close();
    target = null;

    await packageDesktopSnapshot(repoDbPath, path.join(repo, DESKTOP_SNAPSHOT_PATH));
    const signalsCopied = copied.signals ?? 0;
    if (opts.push === false) {
      return { ok: true, copied, pushed: false, skipped: 'push disabled — snapshot package prepared locally' };
    }

    const DB_PATHSPEC = DESKTOP_SNAPSHOT_PATH;
    git(repo, ['add', '-f', '--all', '--', DB_PATHSPEC]);
    if (!git(repo, ['diff', '--cached', '--name-only', '--', DB_PATHSPEC]).trim()) {
      return { ok: true, copied, pushed: true, skipped: 'snapshot unchanged — remote synchronized' };
    }
    git(repo, ['add', '-f', DB_PATHSPEC]);
    // Pathspec-limited commit. This runs unattended after every scrape, so it
    // must capture ONLY the generated package — committing whatever else happened to be
    // staged would sweep unrelated work-in-progress into an automated push.
    git(repo, [
      'commit',
      '-m',
      `chore(data): desktop publish (${signalsCopied} signal(s)) ${DESKTOP_PUBLISH_MARKER}`,
      '--',
      DB_PATHSPEC,
    ]);
    git(repo, ['push', 'origin', 'HEAD:main']);
    console.log(`[web-publish] pushed ${signalsCopied} signal(s) — the site will redeploy.`);
    return { ok: true, copied, pushed: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[web-publish] failed:', error);
    return { ok: false, error };
  } finally {
    if (target) {
      try {
        target.close();
      } catch {
        /* best-effort */
      }
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* the OS temp dir gets cleaned eventually */
      }
    }
    publishInFlight = false;
  }
}
