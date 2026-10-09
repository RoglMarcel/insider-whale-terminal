/* Shared renderer exercised in both production targets with isolated evidence. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'tmp/backtest-ui');
fs.mkdirSync(out, { recursive: true });
const fixtureModule = buildSync({ stdin: { contents: `export { mockApi } from './src/lib/mockApi'; export { analyzeBacktest } from './src/lib/backtest-analysis'; export { sampleSignals } from './src/lib/sampleData'; export { DEFAULT_PORTFOLIO_CONFIG } from './src/types';`, resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'btFixture', alias: { '@': path.join(root, 'src') }, define: { 'import.meta.env.BASE_URL': JSON.stringify('/'), 'import.meta.env.VITE_ANALYSIS_API_URL': JSON.stringify('') } }).outputFiles[0].text;
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const desktop = pathname.startsWith('/desktop/');
  const directory = path.join(root, desktop ? 'dist' : 'dist-web');
  const relative = desktop ? pathname.slice('/desktop'.length) : pathname;
  const file = path.resolve(directory, '.' + (relative === '/' ? '/index.html' : relative));
  if (!file.startsWith(directory + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
let browser;
let lastPage;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  for (const desktop of [false, true]) for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    lastPage = page;
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const initialize = ({ desktop }) => {
      localStorage.setItem('language', 'de'); localStorage.setItem('last_seen_version', '1.7.0');
      const p = { id: 1, ticker: 'TEST', signalId: 1, entryDate: '2026-09-01', entryPrice: 100, shares: 10, costBasis: 1000, entryScore: 80, targetWeight: .1, highWaterClose: 110, exitDate: '2026-09-11', exitPrice: 110, exitReason: 'time', realizedPnl: 100, spyEntry: 100, spyExit: 105 };
      const snapshot = { capturedAt: '2026-09-01T12:00:00Z', provenance: 'original', missingReason: null, decision: { key: 'alert', capturedAt: '2026-09-01T12:00:00Z', logicVersion: '1.7.0-scoring-1', signal: { ...btFixture.sampleSignals[0], ticker: 'TEST' }, parameters: { DEFAULT_SCORING_CONFIG: {} }, context: null }, config: btFixture.DEFAULT_PORTFOLIO_CONFIG, execution: p, currency: 'USD', fees: null, slippageBps: 5 };
      const record = { key: 'a'.repeat(64), portfolio: 'Hauptdepot', portfolioId: 'fixture', strategy: 'test', position: p, snapshot, trades: [{ key: 'buy', side: 'buy', date: p.entryDate, shares: 10, price: 100, value: 1000, fees: null }, { key: 'sell', side: 'sell', date: p.exitDate, shares: 10, price: 110, value: 1100, fees: null }], analyses: [], status: 'complete', replayChanged: false, replayChanges: [] };
      record.analyses.push(btFixture.analyzeBacktest(record, 'original', '2026-09-12T12:00:00Z'));
      const legacy = { ...record, key: 'b'.repeat(64), portfolio: 'Insider Only', position: { ...p, ticker: 'OLD' }, snapshot: { ...snapshot, provenance: 'missing', decision: null, missingReason: 'Historischer Snapshot fehlt' }, status: 'pending', analyses: [] };
      const open = { ...record, key: 'c'.repeat(64), position: { ...p, ticker: 'OPEN', exitDate: null, realizedPnl: null }, status: 'open', analyses: [] };
      window.btState = { schemaVersion: 1, generatedAt: '2026-10-09T12:00:00Z', records: [record, legacy, open], readOnly: !desktop };
      if (desktop) window.api = { ...btFixture.mockApi, app: { ...btFixture.mockApi.app, getVersion: async () => '1.7.0' }, backtest: { getState: async () => structuredClone(window.btState), retry: async key => { const r = window.btState.records.find(r => r.key === key); r.analyses.push(btFixture.analyzeBacktest(r, crypto.randomUUID(), new Date().toISOString())); r.status = 'complete'; return structuredClone(window.btState); } } };
    };
    await page.addInitScript(fixtureModule + '(' + initialize.toString() + ')(' + JSON.stringify({ desktop }) + ');');
    await page.route('**/data/**', async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1);
      const data = name === 'backtest.json' ? await page.evaluate(() => window.btState) : name === 'signals.json' ? [] : name === 'meta.json' ? { version: '1.7.0' } : {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.route('**/intro.mp4', route => route.abort());
    const url = `http://127.0.0.1:${server.address().port}/${desktop ? 'desktop/' : ''}`;
    await page.goto(url);
    const nav = width < 768 ? page.locator('nav') : page.locator('aside');
    await nav.getByRole('button', { name: 'Backtest', exact: true }).click();
    await page.getByRole('button', { name: 'Hauptdepot · TEST', exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 2);
    await page.getByRole('button', { name: 'Hauptdepot · TEST', exact: true }).click();
    await page.getByText('Belegte Beobachtungen', { exact: true }).waitFor();
    await page.getByText('Originaler Kauf-Snapshot, Gewichte und Quelldaten', { exact: true }).click();
    assert(await page.locator('main').innerText().then(t => t.includes('1.7.0-scoring-1')));
    await page.getByRole('button', { name: 'Analyse erneut erstellen', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('select') && [...document.querySelectorAll('option')].some(o => o.textContent.includes('1.7.0-observational-1') && !o.textContent.includes('2026-09-12')));
    await page.getByLabel('Analyseversion', { exact: true }).selectOption('original');
    assert(await page.locator('main').innerText().then(t => t.includes('2026-09-12T12:00:00Z')));
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON exportieren', exact: true }).click();
    const download = await downloadPromise;
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.records[0].analyses.length, 2);
    assert.equal(exported.records[0].snapshot.provenance, 'original');
    await page.getByLabel('Status', { exact: true }).selectOption('open');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('button', { name: 'Hauptdepot · OPEN', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Analyse erneut erstellen', exact: true }).count(), 0);
    await page.getByLabel('Status', { exact: true }).selectOption('closed');
    await page.getByLabel('Snapshot', { exact: true }).selectOption('missing');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('button', { name: 'Insider Only · OLD', exact: true }).click();
    assert(await page.locator('main').innerText().then(t => t.includes('Historischer Snapshot fehlt')));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(out, `${desktop ? 'desktop' : 'web'}-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    if (!desktop) {
      await page.reload(); await nav.getByRole('button', { name: 'Backtest', exact: true }).click();
      await page.getByRole('button', { name: 'Hauptdepot · TEST', exact: true }).click();
      await page.getByLabel('Analyseversion', { exact: true }).selectOption('original');
      assert.equal(await page.getByLabel('Analyseversion', { exact: true }).locator('option').count(), 3);
    }
    console.log(`Backtest ${desktop ? 'desktop' : 'web'} ${width}px: navigation, details, filters, immutable original, version selection, retry, JSON export and layout passed.`);
    await context.close();
  }
})().catch(async e => { console.error(e); process.exitCode = 1;
  if (lastPage && !lastPage.isClosed()) { await lastPage.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(out, 'failure.txt'), await lastPage.locator('body').innerText()); }
}).finally(async () => { if (browser) await browser.close(); server.close(); });
