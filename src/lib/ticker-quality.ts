/** Conservative rules for this US-equity feed. Unknown valid-looking symbols
 * remain unresolved; a missing quote is never evidence of malformed input. */
export function tickerIssue(raw: string | null | undefined): string | null {
  const ticker = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/.test(ticker)) return 'malformed_symbol';
  if (['NVDAEARNINGS', 'GLASFUNDS'].includes(ticker)) return 'non_symbol_text';
  return null;
}

export const TICKER_RENAMES = [{
  from: 'CYBN', to: 'HELP', effectiveDate: '2026-01-05',
  source: 'https://ir.helus.com/news-releases/news-release-details/helus-pharma-propels-therapeutic-innovation-mental-health-and',
}] as const;

export function resolvedTicker(raw: string, date: string): string {
  const ticker = raw.trim().toUpperCase();
  return TICKER_RENAMES.find((r) => r.from === ticker && date >= r.effectiveDate)?.to ?? ticker;
}

export function cleanPortfolioCandidates<T extends { ticker: string; earliestDate: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => !tickerIssue(r.ticker)).map((r) => ({ ...r, ticker: resolvedTicker(r.ticker, r.earliestDate) }));
}
