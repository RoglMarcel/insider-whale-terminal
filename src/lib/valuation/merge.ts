import type { ValuationDocument } from './types';

/** Keep attributed, dated observations when a later collection has no usable response. */
export function mergeValuations(baseline: ValuationDocument, current: ValuationDocument): ValuationDocument {
  const stocks: ValuationDocument['stocks'] = {};
  for (const ticker of new Set([...Object.keys(baseline.stocks), ...Object.keys(current.stocks)])) {
    const providers = new Map();
    for (const row of [...(baseline.stocks[ticker] ?? []), ...(current.stocks[ticker] ?? [])]) {
      const previous = providers.get(row.provider);
      if (!previous || Date.parse(row.fetchedAt) >= Date.parse(previous.fetchedAt)) providers.set(row.provider, row);
    }
    if (providers.size) stocks[ticker] = [...providers.values()];
  }
  return { schemaVersion: 1, generatedAt: current.generatedAt, stocks };
}
