import type { BacktestRecord, BacktestState, BacktestAnalysis } from '../types/backtest';

/** The purchased alert is identified by economic fill, never by device IDs. */
export function backtestIdentity(r: BacktestRecord): string {
  const p = r.snapshot.execution;
  return JSON.stringify([r.portfolio, r.strategy, p.ticker, p.entryDate, p.entryPrice, p.shares, p.costBasis, p.entryScore, p.targetWeight, p.spyEntry]);
}
export function mergeAnalysisVersions(versions: BacktestAnalysis[]): BacktestAnalysis[] {
  return [...new Map(versions.map(a => [a.id, a])).values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function normalizeBacktestState(state: BacktestState): BacktestState {
  const groups = new Map<string, BacktestRecord[]>();
  for (const r of state.records) {
    if (r.portfolio !== 'Hauptdepot') continue;
    const id = backtestIdentity(r);
    const group = groups.get(id) ?? [];
    group.push(r); groups.set(id, group);
  }
  const records = [...groups.values()].map(group => {
    if (group.length === 1) return group[0];
    // Prefer original evidence and the completed trade over an older open copy.
    group.sort((a,b) => Number(b.snapshot.provenance === 'original') - Number(a.snapshot.provenance === 'original') || Number(b.status !== 'open') - Number(a.status !== 'open') || a.key.localeCompare(b.key));
    const winner = group[0];
    const sourceRecords = group.flatMap(r => r.sourceRecords ?? [r]);
    const analyses = mergeAnalysisVersions(group.flatMap(r => r.analyses));
    return { ...winner, analyses, sourceRecords,
      status: winner.status === 'open' ? 'open' as const : analyses.at(-1)?.status ?? winner.status,
      replayChanged: group.some(r => r.replayChanged),
      replayChanges: [...new Map(group.flatMap(r => r.replayChanges).map(r => [JSON.stringify(r),r])).values()],
    };
  });
  return { ...state, records };
}

/** Show the same published archive; local evidence remains stored separately. */
export function mergePublishedBacktest(published: BacktestState, local: BacktestState): BacktestState {
  const byIdentity = new Map(normalizeBacktestState(local).records.map(r => [backtestIdentity(r), r]));
  return { ...normalizeBacktestState(published), readOnly: true, records: normalizeBacktestState(published).records.map(r => {
    const same = byIdentity.get(backtestIdentity(r));
    const analyses = mergeAnalysisVersions([...r.analyses, ...(same?.analyses ?? [])]);
    return { ...r, analyses, status: r.status === 'open' ? 'open' : analyses.at(-1)?.status ?? r.status };
  }) };
}
