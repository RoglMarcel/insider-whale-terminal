import type { PortfolioConfig, PortfolioExperiment, PortfolioState } from '../types';
import { computeStats, simulatePortfolio, toClosedPosition, toOpenPosition, type PortfolioSimInput } from './portfolio-rules';

export const INSIDER_ONLY_ID = 'insider-only-v1';
export const INSIDER_ONLY_DEFINED_AT = '2026-09-23';

/** Equal target tickets at ENTRY; gains may subsequently drift above 20%. */
export function insiderOnlyConfig(base: PortfolioConfig): PortfolioConfig {
  return { ...base, startingCash: 10_000, cashPolicy: 'idle',
    baseWeight: 0.2, maxWeight: 0.2, minWeight: 0.2, maxPositions: 5 };
}

export function buildInsiderOnly(input: PortfolioSimInput, builtAt: string): PortfolioExperiment {
  const config = insiderOnlyConfig(input.config);
  const sim = simulatePortfolio({ ...input, config });
  const last = sim.equity.at(-1);
  const open = last ? sim.positions.filter((p) => !p.exitDate).map((p) => {
    const series = input.prices[p.ticker] ?? {};
    const priceAsOf = Object.keys(series).filter((d) => d >= p.entryDate && d <= last.date && series[d] > 0 && Number.isFinite(series[d])).sort().at(-1) ?? null;
    const position = toOpenPosition(p, priceAsOf ? series[priceAsOf] : null, last.date, last.equity, config);
    const priceStale = priceAsOf !== last.date;
    return { ...position, priceAsOf, priceStale,
      nearestBarrier: priceStale ? null : position.nearestBarrier,
      nearestBarrierPct: priceStale ? null : position.nearestBarrierPct };
  }) : [];
  const closed = sim.positions.filter((p) => p.exitDate).map(toClosedPosition).sort((a, b) => b.exitDate!.localeCompare(a.exitDate!));
  const count = (kind: string) => sim.events.filter((e) => e.kind === kind).length;
  const state: PortfolioState = {
    config, equity: sim.equity, open, closed, events: sim.events,
    stats: computeStats(sim.equity, closed, open, config),
    meta: { available: !!last, firstDate: sim.equity[0]?.date ?? null, lastDate: last?.date ?? null,
      backfillStart: sim.equity[0]?.date ?? null, liveStart: INSIDER_ONLY_DEFINED_AT, lastRun: builtAt,
      skippedNoCash: count('skipped_no_cash'), skippedCap: count('skipped_cap'), missingPrices: count('data_missing'),
      suspectPrices: 0, untradableTickers: sim.untradable, restatedDays: 0, priceAsOf: last?.date ?? null,
      readOnly: true, note: null },
  };
  return { id: INSIDER_ONLY_ID, definedAt: INSIDER_ONLY_DEFINED_AT, state };
}
