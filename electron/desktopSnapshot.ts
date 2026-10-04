import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export const DESKTOP_SNAPSHOT_PATH = 'data/desktop-publish';
export const SNAPSHOT_CHUNK_BYTES = 32 * 1024 * 1024;

/** Transport a closed SQLite export, never a live database or its credentials. */
export async function packageDesktopSnapshot(source: string, directory: string, chunkBytes = SNAPSHOT_CHUNK_BYTES): Promise<void> {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > SNAPSHOT_CHUNK_BYTES) {
    throw new Error('Invalid desktop snapshot chunk size');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwt-transport-'));
  try {
    const archive = path.join(temp, 'snapshot.gz');
    await pipeline(fs.createReadStream(source), createGzip(), fs.createWriteStream(archive));
    const staged = path.join(temp, 'parts');
    fs.mkdirSync(staged);
    const parts: { name: string; bytes: number; sha256: string }[] = [];
    const hash = createHash('sha256');
    const fd = fs.openSync(archive, 'r');
    try {
      const buffer = Buffer.alloc(chunkBytes);
      let offset = 0;
      while (offset < fs.statSync(archive).size) {
        const length = fs.readSync(fd, buffer, 0, chunkBytes, offset);
        if (!length) throw new Error('Unexpected end of snapshot');
        const bytes = buffer.subarray(0, length);
        const name = `part-${String(parts.length).padStart(6, '0')}.gzpart`;
        fs.writeFileSync(path.join(staged, name), bytes);
        parts.push({ name, bytes: length, sha256: createHash('sha256').update(bytes).digest('hex') });
        hash.update(bytes);
        offset += length;
      }
    } finally { fs.closeSync(fd); }
    fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify({
      version: 1, format: 'sqlite-gzip', sha256: hash.digest('hex'), parts,
    }, null, 2) + '\n');
    // Git commits the manifest and all parts together. Preparation must finish
    // before touching the previous package; no raw DB is ever staged.
    fs.mkdirSync(directory, { recursive: true });
    for (const name of fs.readdirSync(directory)) {
      if (name === 'manifest.json' || /^part-\d{6}\.gzpart$/.test(name)) fs.unlinkSync(path.join(directory, name));
    }
    for (const name of fs.readdirSync(staged)) fs.copyFileSync(path.join(staged, name), path.join(directory, name));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
