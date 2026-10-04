import type { FundamentalDatum, FairValueResult } from '../../src/types/fairValue';
import { calculateFairValue } from '../fairValue';
import { scopedFetch, checkCancelled } from './cancellation';
import { fetchMarketQuote, fundamentalsLocation } from '../marketData';
import { fetchExternalFairValues, compareExternalFairValues } from './externalFairValue';
import { useScrapling, scraplingHtml } from './scrapling';

const UA = 'Mozilla/5.0 (compatible; InsiderTracker/1.5)';
const text = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
export function parseFundamentalNumber(raw: string): number | undefined {
  const s = raw.replace(/[$,%\s,]/g, '').replace(/−/g, '-');
  if (!/^[+-]?\d+(?:\.\d+)?[TBMK]?$/i.test(s)) return undefined;
  const scale = ({ T: 1e12, B: 1e9, M: 1e6, K: 1e3 } as Record<string, number>)[s.slice(-1).toUpperCase()] ?? 1;
  const n = parseFloat(s) * scale;
  return Number.isFinite(n) ? n : undefined;
}

/** Exact table-cell labels only: narrative, scripts and estimates never become actuals. */
export function parseFundamentals(html: string, source: string, fetchedAt: string, provider: 'stockanalysis' | 'finviz'): Record<string, FundamentalDatum> {
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const rows = new Map<string, string>();
  for (const row of clean.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => text(m[1]));
    for (let i = 0; i + 1 < cells.length; i += 2) rows.set(cells[i], cells[i + 1]);
  }
  const labels: Record<string, string> = provider === 'stockanalysis' ? {
    eps: 'Earnings Per Share (EPS)', bookPerShare: 'Book Value Per Share', shares: 'Shares Outstanding',
    revenue: 'Revenue', ebit: 'EBIT', ebitda: 'EBITDA', cash: 'Cash & Marketable Securities', debt: 'Total Debt',
    fcf: 'Free Cash Flow', netBorrowing: 'Net Borrowing', operatingCash: 'Operating Cash Flow',
    dividend: 'Dividend Per Share', marketCap: 'Market Cap', pe: 'PE Ratio',
    revenueGrowth: 'Revenue Growth Forecast (3Y)', fcfPerShare: 'FCF Per Share', forwardPE: 'Forward PE',
    taxRate: 'Effective Tax Rate', interestCoverage: 'Interest Coverage', roe: 'Return on Equity (ROE)',
    roic: 'Return on Invested Capital (ROIC)', payoutRatio: 'Payout Ratio', beta: 'Beta (5Y)',
    ps: 'PS Ratio', pb: 'PB Ratio', pcf: 'P/OCF Ratio', ptbv: 'P/TBV Ratio', peg: 'PEG Ratio',
    evEbit: 'EV / EBIT', evEbitda: 'EV / EBITDA', evSales: 'EV / Sales', dividendYield: 'Dividend Yield',
    epsGrowth: 'EPS Growth Forecast (3Y)', analystTarget: 'Price Target', wacc: 'Weighted Average Cost of Capital (WACC)',
  } : { eps: 'EPS (ttm)', bookPerShare: 'Book/sh', price: 'Price', dividend: 'Dividend TTM', epsGrowth: 'EPS next 5Y', beta: 'Beta', analystTarget: 'Target Price' };
  const out: Record<string, FundamentalDatum> = {};
  for (const [key, label] of Object.entries(labels)) {
    const raw = rows.get(label) ?? (key === 'cash' ? rows.get('Cash & Cash Equivalents') : undefined);
    if (raw == null) continue;
    const n = parseFundamentalNumber(key === 'dividend' ? raw.replace(/\s*\([^)]*\)\s*$/, '') : raw);
    if (n != null) out[key] = { value: /Growth|wacc|taxRate|roe|roic|payoutRatio|dividendYield/.test(key) ? n / 100 : n, source, fetchedAt };
  }
  const derive = (key: string, value: number) => { if (Number.isFinite(value)) out[key] = { value, source, fetchedAt }; };
  // Market cap and shares are rounded: their quotient is NOT a quote.
  if (out.shares?.value > 0) {
    if (out.fcf && out.netBorrowing) derive('fcfePerShare', (out.fcf.value + out.netBorrowing.value) / out.shares.value);
    if (out.fcf) derive('normalizedFcfePerShare', out.fcf.value / out.shares.value);
    if (out.revenue) derive('salesPerShare', out.revenue.value / out.shares.value);
    if (out.operatingCash) derive('operatingCashPerShare', out.operatingCash.value / out.shares.value);
  }
  return out;
}

export async function fetchFairValue(ticker: string, industry?: string): Promise<FairValueResult> {
  const inputs: Record<string, FundamentalDatum> = {};
  const warnings: string[] = [];
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || ticker.includes('..')) return calculateFairValue({}, Date.now(), ['Unsupported ticker']);
  const quote = await fetchMarketQuote(ticker);
  // Start alongside fundamentals so a slow comparison cannot consume the entire analysis budget.
  const externalRequest = fetchExternalFairValues(ticker, quote).catch(() => []);
  const location = fundamentalsLocation(ticker);
  let financialCurrency = location?.us ? 'USD' : '';
  if (quote) inputs.price = { value: quote.price, source: quote.source, fetchedAt: new Date().toISOString() };
  if (quote?.currency === 'USD' && location?.us) inputs.usdRiskModel = { value: 1, source: quote.source, fetchedAt: new Date().toISOString() };
  for (const provider of ['stockanalysis', 'finviz'] as const) {
    if (!location || (provider === 'finviz' && (!location.us || inputs.eps))) break;
    const url = provider === 'stockanalysis'
      ? location.url
      : `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`;
    try {
      let html: string;
      if (useScrapling()) html = await scraplingHtml(url);
      else {
        const response = await scopedFetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) { warnings.push(`${provider}: HTTP ${response.status}`); continue; }
        html = await response.text();
      }
      checkCancelled();
      // Both adapters target US listings; reject unknown currencies and mismatched stock pages.
      const title = text(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
      const escapedTicker = location.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\.', '[.-]');
      if (!new RegExp(`(^|[^A-Z0-9.-])${escapedTicker}([^A-Z0-9.-]|$)`, 'i').test(title)) {
        warnings.push(`${provider}: listing/currency could not be verified`); continue;
      }
      const parsed = parseFundamentals(html, url, new Date().toISOString(), provider);
      const observedIndustry = industry || /industry:\s*"([^"\\]+)"/.exec(html)?.[1];
      if (observedIndustry && /\b(banks?|insurance|credit services)\b/i.test(observedIndustry)) {
        parsed.financialCompany = { value: 1, source: url, fetchedAt: new Date().toISOString() };
      }
      if (provider === 'stockanalysis' && !location.us) {
        financialCurrency = /had revenue of\s+([A-Z]{3})\b/.exec(text(html))?.[1] ?? '';
      }
      for (const [key, datum] of Object.entries(parsed)) if (!inputs[key]) inputs[key] = datum;
      if (!Object.keys(parsed).length) warnings.push(`${provider}: no recognized fundamentals`);
    } catch {
      checkCancelled();
      warnings.push(`${provider}: unavailable or timed out`);
    }
  }
  if (quote && financialCurrency !== quote.currency) {
    // No silent EUR/USD or pounds/pence mixing. Quotation remains available.
    for (const key of Object.keys(inputs)) if (key !== 'price') delete inputs[key];
    warnings.push(`Financial currency ${financialCurrency || 'unknown'} does not match quote currency ${quote.currency}; valuation withheld.`);
  }
  if (!location) warnings.push('No fundamentals adapter for this listing; quote only.');
  if (quote && Date.now() - Date.parse(quote.asOf) > 5 * 86_400_000) {
    delete inputs.price;
    warnings.push('Market quote older than five days; current valuation signal withheld.');
  }
  warnings.push('TTM and analyst snapshots; growth forecasts are estimates, not guaranteed cashflows.');
  if (inputs.financialCompany) warnings.push('Financial company: generic industrial FCF models excluded; deposits, lending and regulatory capital need sector-specific treatment.');
  const result = calculateFairValue(inputs, Date.now(), warnings);
  result.currency = quote?.currency || financialCurrency || 'USD';
  if (quote) result.quote = { source: quote.source, asOf: quote.asOf, name: quote.name, exchange: quote.exchange, session: 'regular', delayed: true };
  result.externalComparisons = compareExternalFairValues(result, await externalRequest);
  checkCancelled();
  return result;
}
