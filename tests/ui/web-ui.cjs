/* Browser regression checks use isolated test data, never the published snapshots. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'tmp/ui');
fs.mkdirSync(out, { recursive: true });
const bundle = buildSync({ stdin: { contents: `
  export { sampleSignals, sampleLogs } from './src/lib/sampleData';
  export { simulatePortfolio, emptyPortfolioState, computeStats, toOpenPosition, toClosedPosition } from './src/lib/portfolio-rules';
  export { buildInsiderOnly } from './src/lib/insider-only';
  export { DEFAULT_PORTFOLIO_CONFIG } from './src/types';
  export { summarizeAlertSources } from './src/lib/alert-sources';
  export { calculateFairValue } from './electron/fairValue';
`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@': path.join(root, 'src') } });
const fixtureFile = path.join(root, 'tmp/ui-fixtures.cjs');
fs.writeFileSync(fixtureFile, bundle.outputFiles[0].text);
const { sampleSignals, sampleLogs, simulatePortfolio, emptyPortfolioState, computeStats, toOpenPosition, toClosedPosition, buildInsiderOnly, DEFAULT_PORTFOLIO_CONFIG, summarizeAlertSources, calculateFairValue } = require(fixtureFile);
const dates = Array.from({ length: 32 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
const series = (fn) => Object.fromEntries(dates.map((d, i) => [d, fn(i)]));
const input = { config: { ...DEFAULT_PORTFOLIO_CONFIG, inceptionDate: dates[0], slippageBps: 0 }, tradingDays: dates, spy: series(i => 100 + i * .2), prices: { AAA: series(i => 100 + i * .4) }, candidates: [{ ticker: 'AAA', score: 80, earliestDate: dates[0], signalId: null, source: 'signal' }] };
const simulated = simulatePortfolio(input);
const last = simulated.equity.at(-1);
const open = simulated.positions.filter(p => !p.exitDate).map(p => toOpenPosition(p, input.prices[p.ticker][last.date], last.date, last.equity, input.config));
const closed = simulated.positions.filter(p => p.exitDate).map(toClosedPosition);
const portfolio = { ...emptyPortfolioState(), config: input.config, equity: simulated.equity, open, closed, events: simulated.events, stats: computeStats(simulated.equity, closed, open, input.config) };
Object.assign(portfolio.meta, { available: true, readOnly: true, firstDate: dates[0], lastDate: last.date, priceAsOf: last.date, lastRun: '2026-10-02T12:00:00Z' });
portfolio.meta.note = 'Computed by the scheduled run — hosted build reads the published result.';
portfolio.insiderOnly = buildInsiderOnly(input, '2026-09-23T12:00:00Z');
portfolio.insiderOnly.state.meta.readOnly = true;
const fixtures = {
  'signals.json': sampleSignals.map(s => ({ ...s, breakdown: { ...s.breakdown, notes: [...s.breakdown.notes, '⚡ Recorded insider buying ×1.2'] } })),
  'meta.json': { version: 'ui-test', generatedAt: '2026-10-02T12:00:00Z', runs: sampleLogs, vix: null },
  'portfolio.json': portfolio,
  'update-health.json': { stages: Object.fromEntries(['signals', 'portfolio', 'outcomes'].map(k => [k, { status: 'partial', source: 'Desktop', reason: 'CEOWatcher scraper returned zero rows', lastUpdatedAt: '2026-10-02T12:00:00Z' }])) },
};
const valuationNow=Date.now();
const alertValuations=Object.fromEntries(sampleSignals.map(s=>[s.ticker,calculateFairValue(Object.fromEntries(Object.entries({eps:8,price:100,normalizedFcfePerShare:10,epsGrowth:.06,beta:.5,usdRiskModel:1}).map(([key,value])=>[key,{value,source:'https://stockanalysis.com/stocks/'+s.ticker.toLowerCase()+'/statistics/',fetchedAt:new Date(valuationNow).toISOString()}])),valuationNow)]));
fixtures['analysis-summary.json']={generatedAt:new Date(valuationNow).toISOString(),stocks:alertValuations};
for(const s of sampleSignals)fixtures[s.ticker+'.json']={ticker:s.ticker,valuation:alertValuations[s.ticker],origin:'scheduled'};
// Finance fixtures are explicitly synthetic; live collection is tested separately.
fixtures['valuations.json'] = { schemaVersion: 1, generatedAt: '2026-10-03T12:00:00Z', stocks: Object.fromEntries(sampleSignals.map(signal => [signal.ticker, [{ ticker: signal.ticker, provider: 'stockrow', url: 'https://stockrow.com/' + signal.ticker, fetchedAt: '2026-10-03T12:00:00Z', currency: 'USD', statementDate: '2026-09-30', price: 50, priceAsOf: '2026-10-02', facts: Object.fromEntries(Object.entries({ shares: 10, operatingCashFlow: 90, capex: 30, netBorrowing: 5, eps: 5, dividendPerShare: 2 }).map(([key,value]) => [key, { value, period: '2026-09-30', unit: key === 'shares' ? 'shares' : ['eps','dividendPerShare'].includes(key) ? 'perShare' : 'currency' }])), annual: { pe: [10,12,14].map((value,i) => ({ value, period: `${2025-i}-09`, unit: 'ratio' })) } }]])) };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, 'dist-web', '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(path.join(root, 'dist-web') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
let browser;
let currentPage;
const results = [];
async function checkPage(page, label) {
  const visible = await page.locator('body').innerText();
  assert(!/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u.test(visible), `${label}: emoji in visible text`);
  assert(!/SCRAPE_SESSIONS|GitHub.?Secrets|scraper|scraping|session.?cookies|Desktop|\bCI\b|Quellen-Status|Source health|scheduled run|Login zum Scrapen/i.test(visible), `${label}: public operational information`);
  assert.equal(await page.locator('[role="alert"]').count(), 0, `${label}: status banner`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: document overflow`);
  assert(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${label}: main overflow`);
  await page.screenshot({ path: path.join(out, `${label}.png`) });
}
async function navigate(page, width, view) {
  const labels = { dashboard: /^Alerts$/, portfolio: /^(Paper|Portfolio)$/, history: /^(History|Verlauf)$/, settings: /^(Setup|Settings)$/, watchlist: /\b(Watch|Watchlist)\b/ };
  if (width < 768) await page.locator('nav').filter({ has: page.locator('button[aria-current]') }).getByRole('button', { name: labels[view] }).click();
  else {
    if (width < 1024) await page.getByRole('button', { name: /^(Open menu|Menü öffnen)$/, exact: true }).click();
    await page.locator('aside').getByRole('button', { name: labels[view] }).click();
  }
}
async function contextPage(width, mode = 'full') {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  const page = await context.newPage();
  currentPage = page;
  const jsErrors = []; page.on('pageerror', e => jsErrors.push(e.message));
  await page.route('**/data/*.json', async route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (mode === 'error' && ['signals.json', 'meta.json', 'portfolio.json'].includes(name)) return route.fulfill({ status: 503, body: 'Service unavailable' });
    let data = fixtures[name];
    if (mode === 'empty') data = name === 'signals.json' ? [] : name === 'meta.json' ? { ...fixtures[name], runs: [] } : data;
    if (mode === 'no-high' && name === 'signals.json') data = data.map(s => ({ ...s, convictionLevel: 'LOW' }));
    if (!data) return route.fulfill({ status: 404 });
    await route.fulfill({ json: data });
  });
  // Only third-party embeds are excluded; app assets/data are exercised normally.
  await page.route('**/s.tradingview.com/**', route => route.fulfill({ body: '<html><body>Chart embed</body></html>', contentType: 'text/html' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main').innerText.includes('Loading…'));
  return { context, page, jsErrors };
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 820, 390, 320]) {
    const { page, context, jsErrors } = await contextPage(width);
    await page.locator('main [role="button"][aria-label="NVDA"]').waitFor();
    await page.waitForFunction(()=>document.querySelector('[aria-label="NVDA"] [data-alert-fair-value]')?.innerText.includes('%'));
    assert.equal(await page.locator('[data-alert-fair-value]').count(), await page.locator('.signal-card').count(), 'Every visible alert has a fair-value block');
    assert.equal(await page.locator('main [aria-label="NVDA"] .font-mono-terminal').first().evaluate(el => getComputedStyle(el).color), 'rgb(237, 237, 241)', 'Ticker text contrast');
    await checkPage(page, `${width}-alerts`);
    const heights = await page.locator('.signal-card').evaluateAll(cards => cards.map(c => c.getBoundingClientRect().height));
    assert(Math.max(...heights) - Math.min(...heights) < 2, 'Consistent alert card heights');
    const icons = await page.getByTestId('summary-stats').locator('svg').evaluateAll(icons => icons.map(i => i.innerHTML));
    assert.notEqual(icons[0], icons[3], 'Combo and total signal icons are distinct');
    await page.locator('main [role="button"][aria-label="NVDA"]').click();
    await page.getByText('Additional institutional valuation models', {exact:true}).click();
    await page.locator('.valuation-models details').last().waitFor();
    assert.equal(await page.locator('.valuation-models details').count(), 26);
    await page.locator('[data-model="fcfe"] summary').click();
    assert((await page.locator('[data-model="fcfe"]').innerText()).includes('$'));
    await page.locator('.valuation-assumptions summary').click();
    const growth = page.getByLabel('Forecast growth (%)', {exact:true});
    const before = await page.locator('[data-model="fcfe"] summary').innerText();
    await growth.fill('5');
    assert.notEqual(await page.locator('[data-model="fcfe"] summary').innerText(), before, 'Scenario changes recompute valuation');
    await checkPage(page, `${width}-valuation`);
    await page.getByRole('button', {name:'Close',exact:true}).click();
    const search = page.getByPlaceholder('Search ticker, company, insider…');
    await search.fill('NOT_A_RECORDED_TICKER');
    await page.getByText('No signals match your search', { exact: true }).waitFor();
    await search.fill('NVDA');
    assert.equal(await page.locator('main [role="button"][aria-label="NVDA"]').count(), 1);
    await search.fill('');
    if (width < 768) {
      await page.getByRole('button', { name: 'Open filters', exact: true }).click();
      await page.getByRole('dialog', { name: 'Filter', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Show results', exact: true }).click();
      await page.getByRole('dialog', { name: 'Filter', exact: true }).waitFor({ state: 'hidden' });
    }
    const bell = page.getByRole('button', { name: 'Notifications', exact: true });
    await bell.click();
    await page.getByRole('dialog', { name: 'Notifications', exact: true }).waitFor();
    assert.equal(await page.locator('.notification-list li').count(), sampleSignals.filter(s => s.convictionLevel === 'HIGH').length);
    await checkPage(page, `${width}-notifications`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Notifications', exact: true }).waitFor({ state: 'hidden' });
    assert(await bell.evaluate(el => el === document.activeElement), 'Bell focus restored');
    await bell.click();
    await page.getByRole('dialog', { name: 'Notifications', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog', { name: 'Notifications', exact: true }).waitFor({ state: 'hidden' });
    await bell.click();
    await page.locator('[role="presentation"]').click({ position: { x: 5, y: 5 } });
    await page.getByRole('dialog', { name: 'Notifications', exact: true }).waitFor({ state: 'hidden' });
    await bell.click();
    await page.locator('.notification-list button').first().click();
    await page.locator('[role="dialog"]').waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[role="dialog"]').waitFor({ state: 'hidden' });
    await page.locator('main [role="button"][aria-label="NVDA"]').getByRole('button', { name: 'Add to watchlist', exact: true }).click();
    await navigate(page, width, 'watchlist');
    await page.locator('main [role="button"][aria-label="NVDA"]').waitFor();
    await checkPage(page, `${width}-watchlist`);
    await page.getByRole('button', { name: 'Remove from watchlist', exact: true }).click();
    assert((await page.locator('main').innerText()).includes('Your watchlist is empty'));
    await navigate(page, width, 'portfolio');
    await page.locator('.portfolio-summary').first().waitFor();
    assert.equal(await page.locator('.portfolio-summary').count(), 3);
    assert.equal(await page.locator('.portfolio-headline').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(23, 23, 28)');
    assert.equal(await page.getByRole('checkbox', { name: /cash.drag/i }).count(), 0);
    assert((await page.locator('.portfolio-headline').innerText()).includes('$' + portfolio.equity.at(-1).equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
    await checkPage(page, `${width}-portfolio-2`);
    await page.getByRole('button', { name: '3 · Insider-only', exact: true }).click();
    await page.getByRole('button', { name: /Rules.*Assumptions/i }).click();
    assert.equal(await page.locator('.portfolio-description').count(), 1);
    assert.equal(await page.locator('main').evaluate(el => el.innerText.split('Insider-only: $10,000 start').length - 1), 1);
    await checkPage(page, `${width}-portfolio-3`);
    await page.getByRole('button', { name: '$', exact: true }).click();
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Trade markers', exact: true }).uncheck();
    await navigate(page, width, 'history');
    await page.locator('.history-entry').first().waitFor();
    assert.equal(await page.locator('.history-entry').count(), sampleLogs.length);
    await page.locator('.history-entry summary').first().click();
    assert(await page.locator('.history-entry').first().evaluate(el => el.open));
    await checkPage(page, `${width}-history`);
    await navigate(page, width, 'settings');
    await page.locator('.source-list').waitFor();
    const listed = await page.locator('.source-list li .font-semibold').allTextContents();
    assert.deepEqual(listed, summarizeAlertSources(sampleSignals).map(s => s.name));
    await checkPage(page, `${width}-settings`);
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('de');
    await page.getByText('Quellen der vorhandenen Alerts', { exact: true }).waitFor();
    await checkPage(page, `${width}-settings-de`);
    await navigate(page, width, 'history');
    assert(!/\bOct\b|\bSep\b|\bAM\b|\bPM\b/.test(await page.locator('main').innerText()), 'German dates and time format in history');
    await navigate(page, width, 'dashboard');
    await page.locator('main [role="button"][aria-label="NVDA"]').click();
    await page.getByText('Weitere institutionelle Bewertungsmodelle',{exact:true}).click();
    await page.getByText('Fair Value · 26 Bewertungsmodelle',{exact:true}).waitFor();
    await page.locator('[data-model="fcfe"] summary').click();
    const german = await page.locator('[role="dialog"]').innerText();
    assert(!/insiders buying|of market cap|age decay|Legacy flat-bonus|no fair-value estimate|valuationMultiplier|CONVICTION|forecast years|Bullish|Bearish|POLITICIAN_OPTIONS|POLITICIAN_INSIDER|congressional buying|Insider Trades|No insider history|routine buyer|first buy|Open Market Buy|View filing|Loading signal|\bpts\b|\bHouse\b|\bSenate\b/.test(german), 'German score explanations and labels');
    await checkPage(page, `${width}-valuation-de`);
    await page.getByRole('button', {name:'Schließen',exact:true}).click();
    assert.equal(jsErrors.length, 0, jsErrors.join('\n'));
    results.push({ width, result: 'passed' });
    await context.close();
  }
  for (const mode of ['empty', 'no-high', 'error']) {
    const { page, context } = await contextPage(390, mode);
    if (mode !== 'error') {
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await page.getByRole('dialog', { name: 'Notifications', exact: true }).waitFor();
      assert((await page.locator('[role="dialog"]').innerText()).includes('No high-conviction signals'));
      assert.equal(await page.locator('.notification-list li').count(), 0);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'hidden' });
    } else {
      await page.getByText('This information could not be loaded. Please try again later.').first().waitFor();
      assert(!(await page.locator('main').innerText()).includes('No signals yet'));
    }
    await checkPage(page, `390-${mode}`);
    for (const view of ['portfolio', 'history', 'settings']) {
      await navigate(page, 390, view);
      await checkPage(page, `390-${mode}-${view}`);
    }
    results.push({ mode, result: 'passed' });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
})().catch(async error => { console.error(error); process.exitCode = 1;
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.txt'), await currentPage.locator('body').innerText().catch(() => ''));
  }
}).finally(async () => {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  if (browser) await browser.close();
  server.close();
});
