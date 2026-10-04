import { normalizeAnalysisTicker, type StockAnalysis } from '@/types/analysis';

/** Same-origin server in development; configurable HTTPS service for static hosting. */
export async function requestStockAnalysis(input: string): Promise<StockAnalysis> {
  const ticker = normalizeAnalysisTicker(input);
  const endpoint = import.meta.env.VITE_ANALYSIS_API_URL || '/api/analysis';
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set('ticker', ticker);
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 429 ? 'Viele Analyseanfragen. Bitte in einer Minute erneut versuchen.' : 'Der Analysedienst ist derzeit nicht erreichbar. Bitte später erneut versuchen.');
  const result: StockAnalysis = await response.json();
  if (result?.ticker !== ticker || result?.valuation?.version !== 2 || !Array.isArray(result.valuation.models) || !result.valuation.inputs || !Array.isArray(result.valuation.assumptions) || !Array.isArray(result.valuation.warnings)) {
    throw new Error('Der Analysedienst hat keine gültige Antwort geliefert.');
  }
  return result;
}
