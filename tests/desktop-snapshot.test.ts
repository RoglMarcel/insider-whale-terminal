import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { packageDesktopSnapshot, SNAPSHOT_CHUNK_BYTES } from '../electron/desktopSnapshot';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
describe('desktop snapshot transport', () => {
  it('splits, verifies and reconstructs incompressible data and removes surplus old parts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
    try {
      const source = path.join(tmp, 'export.db');
      const target = path.join(tmp, 'package');
      const bytes = randomBytes(200000);
      fs.writeFileSync(source, bytes);
      await packageDesktopSnapshot(source, target, 65536);
      const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
      expect(manifest.parts.length).toBeGreaterThan(1);
      const parts = manifest.parts.map((p: { name: string; bytes: number; sha256: string }) => {
        const b = fs.readFileSync(path.join(target, p.name));
        expect(b.length).toBe(p.bytes);
        expect(b.length).toBeLessThanOrEqual(SNAPSHOT_CHUNK_BYTES);
        expect(sha(b)).toBe(p.sha256);
        return b;
      });
      const compressed = Buffer.concat(parts);
      expect(sha(compressed)).toBe(manifest.sha256);
      expect(gunzipSync(compressed)).toEqual(bytes);
      fs.writeFileSync(source, 'smaller snapshot');
      await packageDesktopSnapshot(source, target, 65536);
      expect(fs.readdirSync(target).sort()).toEqual(['manifest.json', 'part-000000.gzpart']);
      const before = fs.readFileSync(path.join(target, 'manifest.json'));
      await expect(packageDesktopSnapshot(path.join(tmp, 'missing'), target)).rejects.toThrow();
      expect(fs.readFileSync(path.join(target, 'manifest.json'))).toEqual(before);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
