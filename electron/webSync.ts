import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { getDb } from './database';
import { runHistoryWorker } from './historyBackground';
import { SNAPSHOT_CHUNK_BYTES } from './desktopSnapshot';

const BASE = 'https://roglmarcel.github.io/insider-whale-web/data/shared-history/';
interface Manifest {
  version: number; format: string; sha256: string; generatedAt: string;
  parts: { name: string; bytes: number; sha256: string }[];
}
export interface WebSyncResult { ok: boolean; changed?: boolean; copied?: Record<string, number>; error?: string }
let inFlight: Promise<WebSyncResult> | null = null;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Coalesce startup, refresh and timer requests; no concurrent SQLite imports. */
export function syncFromWeb(): Promise<WebSyncResult> {
  if (!inFlight) inFlight = download().finally(() => { inFlight = null; });
  return inFlight;
}

async function download(): Promise<WebSyncResult> {
  let temp: string | undefined;
  try {
    const response = await fetch(`${BASE}manifest.json`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Web history unavailable (HTTP ${response.status})`);
    const manifest: Manifest = await response.json();
    if (manifest.version !== 1 || manifest.format !== 'sqlite-gzip' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
        !Number.isFinite(Date.parse(manifest.generatedAt)) || !Array.isArray(manifest.parts) ||
        manifest.parts.length < 1 || manifest.parts.length > 64) throw new Error('Invalid web history manifest');
    const previous = getDb().prepare("SELECT value FROM app_settings WHERE key = 'web_sync_revision'").get() as { value: string } | undefined;
    const revision = new Date(manifest.generatedAt).toISOString();
    if (previous && previous.value >= revision) return { ok: true, changed: false };
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwt-web-sync-'));
    const archive = path.join(temp, 'history.gz');
    const hash = createHash('sha256');
    for (const [index, part] of manifest.parts.entries()) {
      if (part.name !== `part-${String(index).padStart(6, '0')}.gzpart` || !Number.isInteger(part.bytes) ||
          part.bytes <= 0 || part.bytes > SNAPSHOT_CHUNK_BYTES || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error('Invalid web history part');
      const res = await fetch(`${BASE}${part.name}`, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Web history part unavailable (HTTP ${res.status})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length !== part.bytes || digest(bytes) !== part.sha256) throw new Error('Web history checksum mismatch; retry after deployment');
      hash.update(bytes);
      fs.appendFileSync(archive, bytes);
    }
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Web history checksum mismatch');
    const source = path.join(temp, 'history.db');
    await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(source));
    const copied = await runHistoryWorker<Record<string, number>>({ operation: 'import', databasePath: getDb().name, source, revision });
    return { ok: true, changed: true, copied };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
