import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fetchFairValue } from '../electron/scraper/fairValue';
import { calculateFairValue } from '../electron/fairValue';
import { parseStockDirectory, type CatalogueStock } from '../electron/analysisCatalogue';
import type { StockAnalysis } from '../src/types/analysis';
import { upgradeFairValue } from '../src/lib/fairValueDisplay';
import { compareExternalFairValues } from '../electron/scraper/externalFairValue';

interface Cache { stocks: CatalogueStock[]; results: Record<string, StockAnalysis> }
const root = path.resolve('public/data');
const cacheFile = path.resolve('data/analysis-cache.json.gz');
function saveCache(bytes: Buffer) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(`${cacheFile}.tmp`, bytes);
  try { fs.renameSync(`${cacheFile}.tmp`, cacheFile); }
  catch (error) {
    // Windows scanners/watchers can deny replacing an open destination.
    if (!['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    fs.copyFileSync(`${cacheFile}.tmp`, cacheFile);
    fs.unlinkSync(`${cacheFile}.tmp`);
  }
}
async function get(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Directory HTTP ${r.status}`);
  return r.text();
}

async function main() {
  fs.mkdirSync(path.join(root, 'analysis'), { recursive: true });
  let cache: Cache = { stocks: [], results: {} };
  try { cache = JSON.parse(gunzipSync(fs.readFileSync(cacheFile)).toString()); } catch { /* first run */ }
  // Recalculate with the new methodology while preserving original source dates.
  for (const result of Object.values(cache.results)) {
    const old = upgradeFairValue(result.valuation);
    const recalculated = calculateFairValue(old.inputs, Date.parse(old.calculatedAt), old.warnings.filter(w=>!w.startsWith('Model corridor is')));
    result.valuation = {...recalculated,currency:old.currency,quote:old.quote};
    result.valuation.externalComparisons = compareExternalFairValues(result.valuation, old.externalComparisons || []);
  }
  const sources: [string, string, string, number][] = [
    ['https://stockanalysis.com/stocks/', '', 'US', 20],
    ['https://stockanalysis.com/list/deutsche-boerse-xetra/', '.DE', 'XETRA', 1],
    ['https://stockanalysis.com/list/london-stock-exchange/', '.L', 'London', 1],
    ['https://stockanalysis.com/list/euronext-paris/', '.PA', 'Paris', 1],
    ['https://stockanalysis.com/list/euronext-amsterdam/', '.AS', 'Amsterdam', 1],
    ['https://stockanalysis.com/list/toronto-stock-exchange/', '.TO', 'Toronto', 1],
    ['https://stockanalysis.com/list/tokyo-stock-exchange/', '.T', 'Tokyo', 1],
    ['https://stockanalysis.com/list/hong-kong-stock-exchange/', '.HK', 'Hong Kong', 1],
    ['https://stockanalysis.com/list/australian-securities-exchange/', '.AX', 'Australia', 1],
    ['https://stockanalysis.com/list/six-swiss-exchange/', '.SW', 'Switzerland', 1],
    ['https://stockanalysis.com/list/borsa-italiana/', '.MI', 'Milan', 1],
    ['https://stockanalysis.com/list/nasdaq-stockholm/', '.ST', 'Stockholm', 1],
  ];
  const discovered = new Map<string, CatalogueStock>();
  for (const [base, suffix, exchange, pages] of sources) {
    try {
      for (let page = 1; page <= pages; page++) {
        const html = await get(page === 1 ? base : `${base}?page=${page}`);
        const rows = parseStockDirectory(html, suffix, exchange);
        for (const row of rows) discovered.set(row.ticker, row);
        if (!html.includes(`?page=${page + 1}`)) break;
      }
    } catch (e) { console.warn(`Directory ${exchange}: ${e instanceof Error ? e.message : 'unavailable'}; retaining previous entries`); }
  }
  for (const s of cache.stocks) {
    const ticker = s.ticker.replace(/\.([AB])\.(ST|CO|HE|TO)$/, '-$1.$2');
    if (!discovered.has(ticker)) discovered.set(ticker, { ...s, ticker });
  }
  cache.stocks = [...discovered.values()];
  const alertTickers = new Set<string>();
  try {
    const signals = JSON.parse(fs.readFileSync(path.join(root,'signals.json'),'utf8'));
    for (const signal of signals) {
      if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(signal.ticker)) continue;
      alertTickers.add(signal.ticker);
      if (!cache.stocks.some(s=>s.ticker===signal.ticker)) cache.stocks.push({ticker:signal.ticker,name:signal.companyName || signal.ticker,exchange:'US'});
      if (signal.breakdown?.fairValue?.fairValue != null) {
        const observed = upgradeFairValue(signal.breakdown.fairValue);
        const old = cache.results[signal.ticker]?.valuation;
        if (!old || Date.parse(observed.calculatedAt)>Date.parse(old.calculatedAt)) cache.results[signal.ticker]={ticker:signal.ticker,valuation:observed,origin:'snapshot'};
      }
    }
  } catch { /* no alerts published on this run */ }
  if (!cache.stocks.length) throw new Error('No stock directory or previous catalogue available');
  function checkpoint() {
    for (const [ticker, result] of Object.entries(cache.results)) {
      if (result.valuation.version === 3 && /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker)) fs.writeFileSync(path.join(root, 'analysis', `${ticker}.json`), JSON.stringify(result));
    }
    fs.writeFileSync(path.join(root, 'analysis-index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), stocks: cache.stocks.map(s => ({ ...s, available: cache.results[s.ticker]?.valuation.version === 3, asOf: cache.results[s.ticker]?.valuation.calculatedAt })) }));
    const bytes = gzipSync(JSON.stringify(cache));
    saveCache(bytes);
    fs.writeFileSync(path.join(root, 'analysis-cache.json.gz'), bytes);
  }
  const age = (s: CatalogueStock) => cache.results[s.ticker]?.valuation.version === 3 && cache.results[s.ticker].valuation.externalComparisons?.some(c => c.provider==='fairvaluecalculator') ? Date.parse(cache.results[s.ticker].valuation.calculatedAt) : 0;
  const priorities = new Set(['AAPL','NVDA','PEP','MCD','GME','MSFT','AMZN','GOOGL','META','TSLA','BRK-B','SAP.DE','ASML.AS','SHEL.L','7203.T','0700.HK',...alertTickers]);
  const queue = cache.stocks.filter(s => process.env.ANALYSIS_FORCE === '1' || Date.now() - age(s) > 18 * 3600_000)
    .sort((a,b) => Number(priorities.has(b.ticker)) - Number(priorities.has(a.ticker)) || age(a) - age(b) || (b.marketCap ?? 0) - (a.marketCap ?? 0));
  const limit = Number(process.env.ANALYSIS_MAX_REFRESH || 2000);
  const selected = queue.slice(0, limit);
  console.log(`Analysis catalogue: ${cache.stocks.length} stocks; refreshing ${selected.length} of ${queue.length} due`);
  let cursor = 0, completed = 0;
  let rateLimited = false;
  const deadline = Date.now() + Number(process.env.ANALYSIS_MAX_MINUTES || 40) * 60_000;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < selected.length && Date.now() < deadline && !rateLimited) {
      const stock = selected[cursor++];
      try {
        const valuation = await fetchFairValue(stock.ticker, stock.industry);
        if (valuation.warnings.some(w => /HTTP 429/.test(w))) {
          rateLimited = true;
          console.warn('Source rate limit: stopping collection; preserving dated snapshots until the next scheduled run.');
        }
        const old = cache.results[stock.ticker];
        // Keep a usable prior snapshot, with its original timestamp, after source outages.
        if (valuation.status !== 'unavailable' || !old || old.valuation.version !== 3) cache.results[stock.ticker] = { ticker: stock.ticker, valuation, origin: 'snapshot' };
      } catch { /* retain earlier snapshot */ }
      if (++completed % 100 === 0) { checkpoint(); console.log(`Analysis: ${completed}/${selected.length}; checkpoint saved`); }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }));
  checkpoint();
  // Same-industry medians from this observed universe; require >=5 OTHER companies.
  const groups = new Map<string, CatalogueStock[]>();
  for (const stock of cache.stocks) if (stock.industry) groups.set(stock.industry, [...(groups.get(stock.industry) ?? []), stock]);
  for (const stock of cache.stocks) {
    const result = cache.results[stock.ticker];
    if (!result || result.valuation.version !== 3 || Date.now() - Date.parse(result.valuation.calculatedAt) > 86_400_000) continue;
    const peers = (groups.get(stock.industry || '') || []).filter(p => p.ticker !== stock.ticker).flatMap(p => {
      const r = cache.results[p.ticker]?.valuation;
      return r && Date.now() - Date.parse(r.calculatedAt) < 86_400_000 ? [r] : [];
    });
    const peerInputs: typeof result.valuation.inputs = {};
    for (const [field, target, max] of [['pe','peerPE',100],['forwardPE','peerForwardPE',100],['ps','peerPS',50],['pb','peerPB',50],['pcf','peerPCF',100],['ptbv','peerPTBV',100],['peg','peerPEG',5],['evEbit','peerEVEBIT',100],['evEbitda','peerEVEBITDA',100],['evSales','peerEVSales',50],['dividendYield','peerDividendYield',.15]] as const) {
      const values=peers.map(r=>r.inputs[field]?.value).filter((n):n is number=>n!=null && n>0 && n<max).sort((a,b)=>a-b);
      if(values.length>=5)peerInputs[target]={value:(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2,source:'https://stockanalysis.com/stocks/',fetchedAt:result.valuation.calculatedAt};
    }
    if (Object.keys(peerInputs).length || /\b(banks?|insurance|credit services)\b/i.test(stock.industry || '')) {
      const old = result.valuation;
      const inputs = { ...old.inputs, ...peerInputs };
      if (/\b(banks?|insurance|credit services)\b/i.test(stock.industry || '')) inputs.financialCompany = { value: 1, source: 'https://stockanalysis.com/stocks/', fetchedAt: old.calculatedAt };
      const priorWarnings = old.warnings.filter(w => !w.startsWith('Peer benchmarks:') && !w.startsWith('Model corridor is'));
      const recalculated = calculateFairValue(inputs, Date.parse(old.calculatedAt), [...priorWarnings, `Peer benchmarks: same-industry (${stock.industry}) same-day medians; at least 5 other positive observations per ratio, extreme ratios excluded. Source universe: ${peers.map(p=>p.quote?.name || 'unnamed').slice(0,20).join(', ')}.`]);
      result.valuation = { ...recalculated, currency: old.currency, quote: old.quote };
      result.valuation.externalComparisons = compareExternalFairValues(result.valuation, old.externalComparisons || []);
    }
  }
  for (const [ticker, result] of Object.entries(cache.results)) {
    if (result.valuation.version === 3 && /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker)) fs.writeFileSync(path.join(root, 'analysis', `${ticker}.json`), JSON.stringify(result));
  }
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'analysis-index.json'), JSON.stringify({ generatedAt, stocks: cache.stocks.map(s => ({ ...s, available: cache.results[s.ticker]?.valuation.version === 3, asOf: cache.results[s.ticker]?.valuation.calculatedAt })) }));
  fs.writeFileSync(path.join(root,'analysis-summary.json'), JSON.stringify({generatedAt,stocks:Object.fromEntries(Object.entries(cache.results).map(([ticker,result])=>[ticker,{...result.valuation,inputs:{},models:[],warnings:[],assumptions:[]}]))}));
  const compressed = gzipSync(JSON.stringify(cache));
  saveCache(compressed);
  fs.writeFileSync(path.join(root, 'analysis-cache.json.gz'), compressed);
  console.log(`Published ${Object.keys(cache.results).length} analysis snapshots (${compressed.length} compressed bytes)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
