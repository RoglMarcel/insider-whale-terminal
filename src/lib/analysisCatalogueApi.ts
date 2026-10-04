import { normalizeAnalysisTicker, type StockAnalysis, type StockSuggestion } from '@/types/analysis';
import { upgradeFairValue } from './fairValueDisplay';
import { searchCatalogue } from '../../electron/analysisCatalogue';
const base = `${import.meta.env.BASE_URL ?? '/'}data/`;
let index: { at: number; stocks: StockSuggestion[] } | null = null;
let pending: Promise<StockSuggestion[]> | null = null;
async function loadIndex(): Promise<StockSuggestion[]> {
  if (index && Date.now() - index.at < 300_000) return index.stocks;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch(`${base}analysis-index.json`, { cache: 'no-cache', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Analysis catalogue unavailable');
    const data = await response.json();
    if (!Array.isArray(data.stocks)) throw new Error('Invalid catalogue');
    const stocks = data.stocks.filter((s: StockSuggestion) => typeof s.ticker === 'string' && typeof s.name === 'string' && typeof s.exchange === 'string');
    index = { at: Date.now(), stocks };
    return stocks;
  })();
  try { return await pending; } finally { pending = null; }
}
export const catalogueAnalysis = {
  search: async (query: string) => searchCatalogue(await loadIndex(), query),
  analyze: async (input: string): Promise<StockAnalysis> => {
    const ticker = normalizeAnalysisTicker(input);
    const response = await fetch(`${base}analysis/${encodeURIComponent(ticker)}.json`, { cache: 'no-cache', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('No published analysis yet for this listing');
    const result = await response.json();
    if (result.ticker !== ticker || !result.valuation || !Array.isArray(result.valuation.models)) throw new Error('Invalid published analysis');
    return { ...result, valuation: upgradeFairValue(result.valuation), origin: 'scheduled' };
  },
};
