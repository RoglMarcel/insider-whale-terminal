import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { filterSignals, isComboSignal } from '@/types';

export interface SignalStats {
  total: number;
  high: number;
  watch: number;
  options: number;
  combos: number;
  totalVolume: number;
}

export function useSignals() {
  const signals = useStore((s) => s.signals);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const scrapeStatus = useStore((s) => s.scrapeStatus);
  const lastScrapeAt = useStore((s) => s.lastScrapeAt);
  const refresh = useStore((s) => s.refresh);
  const openSignal = useStore((s) => s.openSignal);

  // Feature 7 — everything below the header is scoped to the active filter.
  const filteredSignals = useMemo(() => filterSignals(signals, filter), [signals, filter]);

  // Cap a single ticker's contribution so one glitched totalDollarVolume cannot
  // dominate the dashboard aggregate (historical FINS $1.6e15 bug).
  const MAX_SIGNAL_VOLUME = 5_000_000_000 * 20; // 20× single-trade ceiling
  const stats: SignalStats = useMemo(
    () => ({
      total: filteredSignals.length,
      high: filteredSignals.filter((s) => s.convictionLevel === 'HIGH').length,
      watch: filteredSignals.filter((s) => s.convictionLevel === 'WATCH').length,
      options: filteredSignals.filter((s) => (s.optionsActivity?.length ?? 0) > 0).length,
      combos: filteredSignals.filter(isComboSignal).length,
      totalVolume: filteredSignals.reduce((acc, s) => {
        const v = s.totalDollarVolume || 0;
        if (!Number.isFinite(v) || v <= 0 || v > MAX_SIGNAL_VOLUME) return acc;
        return acc + v;
      }, 0),
    }),
    [filteredSignals],
  );

  return { signals, filteredSignals, filter, setFilter, stats, scrapeStatus, lastScrapeAt, refresh, openSignal };
}
