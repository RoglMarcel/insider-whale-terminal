import type { StockSuggestion } from '../src/types/analysis';

export interface CatalogueStock extends StockSuggestion { industry?: string; marketCap?: number }
/** Extract only inert, JSON-escaped primitive fields. Never execute page scripts. */
export function parseStockDirectory(html: string, suffix = '', exchange = 'US'): CatalogueStock[] {
  const out: CatalogueStock[] = [];
  const seen = new Set<string>();
  const str = '"(?:[^"\\\\]|\\\\.)*"';
  const pattern = new RegExp(`\\{(?:no:\\d+,)?s:(${str}),n:(${str}),([^{}]{0,700})\\}`, 'g');
  for (const match of html.matchAll(pattern)) {
    try {
      const raw: string = JSON.parse(match[1]);
      const name: string = JSON.parse(match[2]);
      let symbol = raw.split('/').at(-1)!;
      if (['.ST','.CO','.HE','.TO'].includes(suffix)) symbol = symbol.replace(/\.([AB])$/, '-$1');
      if (suffix === '.HK' && /^\d{1,4}$/.test(symbol)) symbol = symbol.padStart(4, '0');
      const ticker = `${symbol}${suffix}`.toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || seen.has(ticker)) continue;
      const marketCap = Number(/marketCap:([\d.eE+-]+)/.exec(match[3])?.[1]);
      const industryMatch = new RegExp(`industry:(${str})`).exec(match[3]);
      const industry = industryMatch ? JSON.parse(industryMatch[1]) : undefined;
      if (industry === 'Shell Companies' || /\b(warrants?|preferred|rights|units)\b/i.test(name)) continue;
      // USD threshold only; don't compare different currencies' market caps.
      if (!suffix && Number.isFinite(marketCap) && marketCap < 300_000_000) continue;
      seen.add(ticker);
      out.push({ ticker, name, exchange, industry, marketCap: Number.isFinite(marketCap) ? marketCap : undefined });
    } catch { /* malformed primitive */ }
  }
  return out;
}

export function searchCatalogue(stocks: StockSuggestion[], query: string): StockSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return stocks.filter(s => s.ticker.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const rank = (s: StockSuggestion) => s.ticker.toLowerCase() === q ? 0 : s.ticker.toLowerCase().startsWith(q) ? 1 : s.name.toLowerCase().startsWith(q) ? 2 : 3;
      return rank(a) - rank(b) || a.ticker.length - b.ticker.length;
    }).slice(0, 12);
}
