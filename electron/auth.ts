import { randomUUID } from 'node:crypto';
import { requirePlatform } from './securityBoundary';
import { encodeSession, decodeSession } from './sessionCodec';
import { app, safeStorage } from 'electron';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { LOGIN_PLATFORMS, isSourceUnlocked as isUnlockedPure, type AuthStatus, type ScraperSource } from '../src/types';
import { USER_AGENT, exportIndexedDBString, restoreIndexedDBScript } from './scraper/browser';

/**
 * Per-platform authenticated scraping. The user logs in manually in a visible
 * browser window (handles email/password, Google OAuth, CAPTCHA, 2FA - anything),
 * then we capture the session COOKIES (Playwright storageState). No passwords are
 * ever stored; the session blob is encrypted at rest with Electron safeStorage.
 */
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

const activeLogins = new Map<string, { browser: Browser; context: BrowserContext }>();

function sessionsDir(): string {
  const dir = path.join(app.getPath('userData'), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFile(key: string): string {
  requirePlatform(key);
  return path.join(sessionsDir(), `${key}.session`);
}

function saveEncrypted(file: string, bytes: Buffer): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Cache decrypted session state keyed by file mtime so the per-source / per-scrape
// auth checks don't re-read and re-decrypt every .session file on each call.
const stateCache = new Map<string, { mtimeMs: number; state: StorageState | undefined }>();

function loadState(key: string): StorageState | undefined {
  try {
    const f = sessionFile(key);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(f).mtimeMs;
    } catch {
      stateCache.delete(key); // file gone (logged out) — invalidate
      return undefined;
    }
    const cached = stateCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) return cached.state;

    const decoded = decodeSession(fs.readFileSync(f), safeStorage);
    if (decoded.migration) saveEncrypted(f, decoded.migration);
    const state = decoded.state;
    if (state && state.cookies) {
      state.cookies = state.cookies.map(c => {
        const copy: any = { ...c };
        // Clean expires property: remove -1 or past negative timestamps so Chromium handles them as session cookies
        if (copy.expires === -1 || (copy.expires && copy.expires < 0)) {
          delete copy.expires;
        }
        // Rewrite domain to have a leading dot so it applies to subdomains (except __Host- cookies and IP addresses)
        if (copy.domain && !copy.domain.startsWith('.') && !copy.name.startsWith('__Host-') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(copy.domain)) {
          copy.domain = '.' + copy.domain;
        }
        return copy;
      });
    }
    stateCache.set(key, { mtimeMs, state });
    return state;
  } catch {
    return undefined;
  }
}

export function isLoggedIn(key: string): boolean {
  return !!loadState(key);
}

export function authStatus(): AuthStatus {
  const status: AuthStatus = {};
  for (const p of LOGIN_PLATFORMS) {
    const f = sessionFile(p.key);
    if (loadState(p.key)) {
      let savedAt: string | null = null;
      try {
        savedAt = fs.statSync(f).mtime.toISOString();
      } catch {
        /* ignore */
      }
      status[p.key] = { loggedIn: true, savedAt };
    } else {
      status[p.key] = { loggedIn: false, savedAt: null };
    }
  }
  return status;
}

/** Main-side gate used by the orchestrator. */
export function sourceUnlocked(sourceKey: ScraperSource): boolean {
  return isUnlockedPure(sourceKey, authStatus());
}

/** Merge cookies + origins from every (or the given) logged-in platform. */
export function loadMergedStorageState(keys?: string[]): StorageState | undefined {
  const list = (keys ?? LOGIN_PLATFORMS.map((p) => p.key)).filter(isLoggedIn);
  const cookies: StorageState['cookies'] = [];
  const origins: StorageState['origins'] = [];
  const seen = new Set<string>();
  for (const key of list) {
    const state = loadState(key);
    if (!state) continue;
    for (const c of state.cookies ?? []) {
      const id = `${c.name}|${c.domain}|${c.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      cookies.push(c);
    }
    for (const o of state.origins ?? []) origins.push(o);
  }
  if (cookies.length === 0 && origins.length === 0) return undefined;
  return { cookies, origins };
}

export async function startLogin(key: string): Promise<{ ok: boolean; message?: string }> {
  const platform = LOGIN_PLATFORMS.find((p) => p.key === key);
  if (!platform) return { ok: false, message: 'Unknown platform' };
  await cancelLogin(key); // close any prior attempt

  try {
    const browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu'],
    });
    const existing = isLoggedIn(key) ? loadState(key) : undefined;
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      ...(existing ? { storageState: existing } : {}),
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await context.addInitScript(restoreIndexedDBScript);
    browser.on('disconnected', () => activeLogins.delete(key));
    activeLogins.set(key, { browser, context });

    const page = await context.newPage();
    await page.goto(platform.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveLogin(key: string): Promise<{ ok: boolean; message?: string }> {
  requirePlatform(key);
  const active = activeLogins.get(key);
  if (!active) return { ok: false, message: 'No login window is open. Click "Log in" first, sign in, then Save.' };
  try {
    // Run IndexedDB export script on all active pages first to dump into localStorage
    const pages = active.context.pages();
    for (const page of pages) {
      try {
        await page.evaluate(exportIndexedDBString);
      } catch (e) {
        console.error(`[auth] IndexedDB export failed on page ${page.url()}:`, e);
      }
    }

    const state = await active.context.storageState();
    if (!state.cookies?.length) {
      return { ok: false, message: 'No session cookies found - make sure you completed the login first.' };
    }
    saveEncrypted(sessionFile(key), encodeSession(state, safeStorage));
    stateCache.delete(key);
    await active.browser.close().catch(() => undefined);
    activeLogins.delete(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function cancelLogin(key: string): Promise<void> {
  requirePlatform(key);
  const active = activeLogins.get(key);
  if (active) {
    await active.browser.close().catch(() => undefined);
    activeLogins.delete(key);
  }
}

export async function logout(key: string): Promise<AuthStatus> {
  requirePlatform(key);
  await cancelLogin(key);
  try {
    fs.rmSync(sessionFile(key), { force: true });
  } catch {
    /* ignore */
  }
  stateCache.delete(key);
  return authStatus();
}

export async function closeAllLogins(): Promise<void> {
  for (const key of [...activeLogins.keys()]) await cancelLogin(key);
}
