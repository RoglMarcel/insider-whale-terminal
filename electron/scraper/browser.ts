import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { cancellationSignal, checkCancelled, cancellableDelay } from './cancellation';
import type { RawInsiderTrade, OptionsActivity } from '../../src/types';
import { SourceHttpError, retryTransient } from './reliability';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export function getPlaywrightCliPath(): string {
  // Try production app.asar path first
  const prodPath = path.join(process.resourcesPath, 'app.asar', 'node_modules', 'playwright-core', 'cli.js');
  if (fs.existsSync(prodPath)) {
    return prodPath;
  }
  // Try relative paths in development
  const possiblePaths = [
    path.join(__dirname, '..', 'node_modules', 'playwright-core', 'cli.js'),
    path.join(__dirname, '../node_modules/playwright-core/cli.js'),
    path.resolve(process.cwd(), 'node_modules', 'playwright-core', 'cli.js'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return '';
}

export function installChromium(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cliPath = getPlaywrightCliPath();
    if (!cliPath) {
      return reject(new Error('Playwright CLI path not found.'));
    }

    console.log(`[Playwright Auto-Install] Spawning browser installer: ${process.execPath} ${cliPath} install chromium`);
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    child.stdout.on('data', (data) => {
      console.log(`[Playwright Auto-Install stdout]: ${data}`);
    });

    child.stderr.on('data', (data) => {
      console.error(`[Playwright Auto-Install stderr]: ${data}`);
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('[Playwright Auto-Install] Successfully installed Chromium!');
        resolve();
      } else {
        reject(new Error(`Playwright browser installation failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/** A realistic, current Chrome desktop UA (requirement #4). */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type InsiderScraper = (context: BrowserContext, reportIssue?: (message: string) => void) => Promise<RawInsiderTrade[]>;
export type OptionsScraper = (context: BrowserContext) => Promise<OptionsActivity[]>;

export async function launchBrowser(headless: boolean): Promise<Browser> {
  return chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
    ],
  });
}

export async function createContext(
  browser: Browser,
  storageState?: BrowserContextOptions['storageState'],
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // Authenticated scraping - cookies captured by the Settings -> Logins flow.
    ...(storageState ? { storageState } : {}),
  });
  // Light stealth: hide the webdriver flag that some sites check.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.addInitScript(restoreIndexedDBScript);
  return context;
}

export const exportIndexedDBString = `
(async () => {
  if (!window.indexedDB || !window.indexedDB.databases) return;
  try {
    const dbs = await window.indexedDB.databases();
    for (const dbInfo of dbs) {
      const dbName = dbInfo.name;
      if (!dbName) continue;
      await new Promise((resolve) => {
        const openReq = window.indexedDB.open(dbName);
        openReq.onerror = () => resolve();
        openReq.onsuccess = async (event) => {
          const db = event.target.result;
          const version = db.version;
          localStorage.setItem('__idb_version__' + dbName, String(version));
          const storeNames = Array.from(db.objectStoreNames);
          for (const storeName of storeNames) {
            try {
              const entries = await new Promise((res, rej) => {
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                
                // Save metadata
                const meta = {
                  keyPath: store.keyPath,
                  autoIncrement: store.autoIncrement
                };
                localStorage.setItem('__idb_meta__' + dbName + '__' + storeName, JSON.stringify(meta));
                
                const cursorReq = store.openCursor();
                const list = [];
                cursorReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    list.push({ key: cursor.key, value: cursor.value });
                    cursor.continue();
                  } else {
                    res(list);
                  }
                };
                cursorReq.onerror = () => rej(tx.error);
              });
              localStorage.setItem('__idb_dump__' + dbName + '__' + storeName, JSON.stringify(entries));
            } catch (e) {
              console.error('Failed to dump store', storeName, 'from db', dbName, e);
            }
          }
          db.close();
          resolve();
        };
      });
    }
  } catch (err) {
    console.error('Error exporting IndexedDB:', err);
  }
})()
`;

export const restoreIndexedDBScript = `
(() => {
  if (!window.indexedDB) return;
  const originalOpen = window.indexedDB.open;
  let idbRestored = false;
  const pendingRequests = [];

  class DeferredRequest extends EventTarget {
    constructor() {
      super();
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
      this.onblocked = null;
      this.readyState = 'pending';
      this.result = null;
      this.error = null;
    }
  }

  window.indexedDB.open = function(name, version) {
    if (idbRestored) {
      return originalOpen.apply(this, arguments);
    }
    const req = new DeferredRequest();
    pendingRequests.push({
      req,
      name,
      version,
      args: arguments,
      context: this
    });
    return req;
  };

  async function restoreAll() {
    try {
      const prefixVersion = '__idb_version__';
      const prefixDump = '__idb_dump__';
      const prefixMeta = '__idb_meta__';
      
      const dbNames = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefixVersion)) {
          dbNames.push(key.substring(prefixVersion.length));
        }
      }
      
      for (const dbName of dbNames) {
        const version = parseInt(localStorage.getItem(prefixVersion + dbName) || '1', 10);
        const storeNames = [];
        const dumpPrefix = prefixDump + dbName + '__';
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(dumpPrefix)) {
            storeNames.push(key.substring(dumpPrefix.length));
          }
        }
        
        if (storeNames.length === 0) continue;
        
        await new Promise((resolve) => {
          const openReq = originalOpen.call(window.indexedDB, dbName, version);
          openReq.onupgradeneeded = (event) => {
            const db = event.target.result;
            for (const storeName of storeNames) {
              if (!db.objectStoreNames.contains(storeName)) {
                const metaStr = localStorage.getItem(prefixMeta + dbName + '__' + storeName);
                const meta = metaStr ? JSON.parse(metaStr) : null;
                const options = {};
                if (meta) {
                  if (meta.keyPath !== undefined) options.keyPath = meta.keyPath;
                  if (meta.autoIncrement !== undefined) options.autoIncrement = meta.autoIncrement;
                }
                db.createObjectStore(storeName, options);
              }
            }
          };
          openReq.onsuccess = async (event) => {
            const db = event.target.result;
            try {
              const tx = db.transaction(storeNames, 'readwrite');
              for (const storeName of storeNames) {
                const store = tx.objectStore(storeName);
                const entriesStr = localStorage.getItem(prefixDump + dbName + '__' + storeName);
                if (entriesStr) {
                  const entries = JSON.parse(entriesStr);
                  const metaStr = localStorage.getItem(prefixMeta + dbName + '__' + storeName);
                  const meta = metaStr ? JSON.parse(metaStr) : null;
                  const hasKeyPath = meta && meta.keyPath !== null && meta.keyPath !== undefined;
                  
                  for (const entry of entries) {
                    if (hasKeyPath) {
                      store.put(entry.value);
                    } else {
                      store.put(entry.value, entry.key);
                    }
                  }
                }
              }
              await new Promise((res) => {
                tx.oncomplete = res;
                tx.onerror = res;
              });
            } catch (err) {
              console.error('Failed to populate store:', err);
            } finally {
              db.close();
              resolve();
            }
          };
          openReq.onerror = () => resolve();
        });
      }
    } catch (e) {
      console.error('Error during IndexedDB restore:', e);
    } finally {
      idbRestored = true;
      for (const p of pendingRequests) {
        const realReq = originalOpen.apply(p.context, p.args);
        
        function fireEvent(type, realEvent) {
          const ev = new Event(type, { bubbles: realEvent.bubbles, cancelable: realEvent.cancelable });
          Object.defineProperty(ev, 'target', { value: p.req, writable: false });
          if (p.req['on' + type]) {
            try { p.req['on' + type](ev); } catch(err) { console.error(err); }
          }
          p.req.dispatchEvent(ev);
        }

        realReq.onsuccess = (e) => {
          p.req.readyState = realReq.readyState;
          p.req.result = realReq.result;
          fireEvent('success', e);
        };
        realReq.onerror = (e) => {
          p.req.readyState = realReq.readyState;
          p.req.error = realReq.error;
          fireEvent('error', e);
        };
        realReq.onupgradeneeded = (e) => {
          p.req.readyState = realReq.readyState;
          p.req.result = realReq.result;
          fireEvent('upgradeneeded', e);
        };
        realReq.onblocked = (e) => {
          p.req.readyState = realReq.readyState;
          fireEvent('blocked', e);
        };
      }
      pendingRequests.length = 0;
    }
  }

  restoreAll();
})();
`;


/** Random human-like delay between requests to one domain (requirement #3). */
export function randomDelay(min = 1500, max = 3000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return cancellableDelay(ms);
}

export interface NavOptions {
  validateNavigation?: (url: string) => string;
  /** Check HTTP status and retry temporary failures once on a fresh page. */
  reliable?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

/** Open a fresh page, navigate, and hand it to a parser. Always closes the page. */
export async function withPage<T>(
  context: BrowserContext,
  url: string,
  parse: (page: Page) => Promise<T>,
  options: NavOptions = {},
): Promise<T> {
  const run = async () => {
    checkCancelled();
    options.validateNavigation?.(url);
    const page = await context.newPage();
    const signal = cancellationSignal();
    const abort = () => { void page.close().catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) { abort(); checkCancelled(); }
      if (options.validateNavigation) await page.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          try {
            let target = request.url();
            for (let hops = 0; hops < 10; hops++) {
              target = options.validateNavigation!(target);
              // Playwright route handlers do not see automatic HTTP redirects.
              // Fetch each hop explicitly so validation precedes every request.
              const response = await route.fetch({ url: target, maxRedirects: 0 });
              const location = response.headers()['location'];
              if ([301, 302, 303, 307, 308].includes(response.status()) && location) {
                target = new URL(location, target).href;
                await response.dispose();
                continue;
              }
              await route.fulfill({ response });
              await response.dispose();
              return;
            }
          } catch { /* Invalid or failed navigation must not reach the browser. */ }
          await route.abort();
          return;
        }
        await route.continue();
      });
      const response = await page.goto(url, {
        waitUntil: options.waitUntil ?? 'domcontentloaded',
        timeout: options.timeout ?? 30_000,
      });
      if (options.reliable && response && !response.ok()) {
        throw new SourceHttpError(response.status(), response.headers()['retry-after'] ?? null);
      }
      options.validateNavigation?.(page.url());
      const result = await parse(page);
      checkCancelled();
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
      await page.close().catch(() => undefined);
    }
  };
  return options.reliable ? retryTransient(run) : run();
}
