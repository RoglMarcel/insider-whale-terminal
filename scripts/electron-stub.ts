/**
 * Minimal `electron` shim for the headless web runner (`scrape-web.ts`).
 *
 * The scrape orchestrator (`electron/scraper/index.ts`) transitively imports
 * `electron/auth.ts`, which does `import { app, safeStorage } from 'electron'`.
 * On a plain Node runtime (GitHub Actions) there is no Electron, so esbuild
 * aliases `electron` to THIS file (see the `scrape:web` npm script).
 *
 * We only need the tiny surface `auth.ts` actually touches:
 *   - app.getPath('userData')  → a real temp dir (no saved sessions live there,
 *     so every login-gated source is simply treated as "not logged in")
 *   - safeStorage.isEncryptionAvailable() → false (no session decryption needed)
 *
 * Nothing here runs in the desktop build; it is a runner-only stub.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const baseDir = path.join(os.tmpdir(), 'insider-web-runner');

export const app = {
  getPath(name: string): string {
    const dir = name === 'userData' ? path.join(baseDir, 'userData') : path.join(baseDir, name);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
    return dir;
  },
  getVersion(): string {
    return process.env.APP_VERSION ?? '0.0.0-web';
  },
  getName(): string {
    return 'insider-whale-terminal-web';
  },
};

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false;
  },
  encryptString(s: string): Buffer {
    return Buffer.from(s, 'utf8');
  },
  decryptString(b: Buffer): string {
    return Buffer.from(b).toString('utf8');
  },
};

// A few no-op surfaces in case another transitively-imported module reaches for
// them. They are never exercised by the 🟢 runner path but keep bundling safe.
export const safeStorageAvailable = false;
export const Notification = class {
  static isSupported(): boolean {
    return false;
  }
  show(): void {
    /* no-op */
  }
  on(): void {
    /* no-op */
  }
};

export default { app, safeStorage, Notification };
