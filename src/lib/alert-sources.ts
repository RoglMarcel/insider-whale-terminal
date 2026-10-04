import { SCRAPER_SOURCES, type Signal } from '@/types';

export interface AlertSourceSummary {
  key: string;
  name: string;
  kind: 'insider' | 'options';
  alerts: number;
}

/** Counts distinct alerts using their persisted trade/flow attribution, never scraper health. */
export function summarizeAlertSources(signals: Signal[]): AlertSourceSummary[] {
  const counts = new Map<string, Set<string>>();
  for (const signal of signals) {
    for (const record of [...(signal.rawTrades ?? []), ...(signal.optionsActivity ?? [])]) {
      const source = SCRAPER_SOURCES.find((item) => item.key === record.source);
      if (!source) continue;
      const tickers = counts.get(source.key) ?? new Set<string>();
      tickers.add(signal.ticker);
      counts.set(source.key, tickers);
    }
  }
  return SCRAPER_SOURCES.filter((source) => counts.has(source.key))
    .map((source) => ({ key: source.key, name: source.label, kind: source.kind, alerts: counts.get(source.key)!.size }))
    .sort((a, b) => b.alerts - a.alerts || a.name.localeCompare(b.name));
}
