import { normalizeAnalysisTicker, type StockAnalysis } from '../src/types/analysis';
import { fetchFairValue } from './scraper/fairValue';
import { calculateFairValue } from './fairValue';
import { withTimeout } from './scraper/cancellation';
import { getAnalysisSnapshot } from './analysisSnapshot';

const cache = new Map<string, { at: number; result: StockAnalysis }>();
const pending = new Map<string, Promise<StockAnalysis>>();

/** Independent of alerts and the global scraper; bounded and deduplicated. */
export async function analyzeStock(input: unknown): Promise<StockAnalysis> {
  const ticker = normalizeAnalysisTicker(input);
  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.at < (cached.result.valuation.status === 'unavailable' ? 60_000 : 300_000)) return cached.result;
  const existing = pending.get(ticker);
  if (existing) return existing;
  if (pending.size >= 4) throw new Error('Die Analyse ist gerade ausgelastet. Bitte kurz warten und erneut versuchen.');
  const task = (async (): Promise<StockAnalysis> => {
    const fallback = calculateFairValue({}, Date.now(), ['Analysis request exceeded its time budget.']);
    const valuation = await withTimeout(() => fetchFairValue(ticker), 20_000, fallback);
    const prior = getAnalysisSnapshot(ticker);
    const result: StockAnalysis = prior && (valuation.fairValue == null || valuation.status === 'fallback' && prior.valuation.status === 'estimated') ? prior : { ticker, valuation, origin: 'live' };
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(ticker, { at: Date.now(), result });
    return result;
  })();
  pending.set(ticker, task);
  try { return await task; } finally { pending.delete(ticker); }
}
