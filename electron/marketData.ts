import type { StockSuggestion } from '../src/types/analysis';
import { normalizeAnalysisTicker } from '../src/types/analysis';
import { scopedFetch, checkCancelled } from './scraper/cancellation';

const headers = { 'User-Agent': 'Mozilla/5.0' };
export function yahooSymbol(ticker: string): string {
  if (/\.[AB]\.(ST|CO|HE|TO)$/.test(ticker)) return ticker.replace(/\.([AB])\./, '-$1.');
  return /^[A-Z]{1,6}\.[AB]$/.test(ticker) ? ticker.replace('.', '-') : ticker;
}

export interface MarketQuote {
  price: number; currency: string; asOf: string; name: string; exchange: string; source: string;
}
export async function fetchMarketQuote(ticker: string): Promise<MarketQuote | null> {
  const symbol = yahooSymbol(normalizeAnalysisTicker(ticker));
  for (const host of ['query1', 'query2']) {
    const source = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    try {
      const response = await scopedFetch(source, { headers, signal: AbortSignal.timeout(6000) });
      if (!response.ok) continue;
      const data = await response.json();
      const m = data.chart?.result?.[0]?.meta;
      if (!m || m.symbol?.toUpperCase() !== symbol || m.instrumentType !== 'EQUITY' || !Number.isFinite(m.regularMarketPrice) || m.regularMarketPrice <= 0 || !Number.isFinite(m.regularMarketTime) || typeof m.currency !== 'string') continue;
      // London quotes in pence and South African quotes in cents are normalized to major units.
      const divisor = ['GBp', 'GBX', 'ZAc'].includes(m.currency) ? 100 : 1;
      const currency = ['GBp', 'GBX'].includes(m.currency) ? 'GBP' : m.currency === 'ZAc' ? 'ZAR' : m.currency;
      if (!/^[A-Z]{3}$/.test(currency)) continue;
      return { price: m.regularMarketPrice / divisor, currency, asOf: new Date(m.regularMarketTime * 1000).toISOString(), name: m.longName || m.shortName || ticker, exchange: m.fullExchangeName || m.exchangeName || '', source };
    } catch { checkCancelled(); }
  }
  return null;
}

const searches = new Map<string, { at: number; results: StockSuggestion[] }>();
export async function searchStocks(input: unknown): Promise<StockSuggestion[]> {
  if (typeof input !== 'string' || input.trim().length < 1 || input.length > 80) return [];
  const query = input.trim();
  const cache = searches.get(query.toLowerCase());
  if (cache && Date.now() - cache.at < 600_000) return cache.results;
  const source = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0&enableFuzzyQuery=true`;
  const response = await scopedFetch(source, { headers, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('Stock search temporarily unavailable');
  const data = await response.json();
  const results: StockSuggestion[] = [];
  for (const q of data.quotes ?? []) {
    // Exclude futures, funds, crypto and OTC listings, not ordinary low nominal prices.
    if (q.quoteType !== 'EQUITY' || ['PNK', 'OQB', 'OQX', 'OTC'].includes(q.exchange)) continue;
    try { results.push({ ticker: normalizeAnalysisTicker(q.symbol), name: String(q.longname || q.shortname || q.symbol), exchange: String(q.exchDisp || q.exchange || '') }); } catch { /* unsupported symbol */ }
  }
  if (searches.size >= 300) searches.delete(searches.keys().next().value!);
  searches.set(query.toLowerCase(), { at: Date.now(), results });
  return results;
}

const exchanges: Record<string, string> = { DE: 'etr', F: 'fra', L: 'lon', PA: 'epa', AS: 'ams', TO: 'tsx', V: 'tsxv', HK: 'hkg', T: 'tyo', SW: 'swx', AX: 'asx', MI: 'bit', MC: 'bme', ST: 'sto', CO: 'cph', HE: 'hel', OL: 'osl', SI: 'sgx', NS: 'nse', BO: 'bom', KS: 'krx', KQ: 'kosdaq', NZ: 'nze', BR: 'ebr', LS: 'eli', WA: 'wse', TA: 'tlv', JO: 'jse' };
export function fundamentalsLocation(ticker: string): { url: string; symbol: string; us: boolean } | null {
  const match = /^(.*)\.([A-Z]+)$/.exec(ticker);
  if (match && exchanges[match[2]]) {
    const symbol = ['ST','CO','HE','TO'].includes(match[2]) ? match[1].replace(/-([AB])$/, '.$1') : match[1];
    return { url: `https://stockanalysis.com/quote/${exchanges[match[2]]}/${encodeURIComponent(symbol)}/statistics/`, symbol, us: false };
  }
  if (match && !/^[A-Z]{1,6}\.[AB]$/.test(ticker)) return null;
  return { url: `https://stockanalysis.com/stocks/${encodeURIComponent(yahooSymbol(ticker).toLowerCase())}/statistics/`, symbol: ticker, us: true };
}
