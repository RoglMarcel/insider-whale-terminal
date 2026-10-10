import { normalizeBacktestState, mergeAnalysisVersions } from './backtest-records';
import type { BacktestState, BacktestAnalysis } from '../types/backtest';
import { analyzeBacktest } from './backtest-analysis';

const STORAGE_KEY = 'backtest-analysis-versions-v1';
type Versions = Record<string, BacktestAnalysis[]>;
function versions(): Versions {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) as Versions : {};
}
export function mergeLocalBacktest(state: BacktestState): BacktestState {
  state = normalizeBacktestState(state);
  let local: Versions;
  try { local = versions(); }
  catch { return { ...state, readOnly: true, localError: 'Lokale Analyseversionen konnten nicht gelesen werden. Die veröffentlichten Originaldaten bleiben verfügbar.' }; }
  return { ...state, readOnly: true, records: state.records.map(r => {
    const analyses = mergeAnalysisVersions([...r.analyses, ...[r.key, ...(r.sourceRecords ?? []).map(s => s.key)].flatMap(key => local[key] ?? [])]);
    return { ...r, analyses, status: r.status === 'open' ? 'open' : analyses.at(-1)?.status ?? r.status };
  }) };
}
/** Static hosting has no write API. Explicitly local versions survive reloads and export. */
export function retryLocalBacktest(state: BacktestState, key: string): BacktestState {
  state = normalizeBacktestState(state);
  const r = state.records.find(r => r.key === key);
  if (!r || r.status === 'open') throw new Error('Geschlossene Position nicht gefunden');
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let a: BacktestAnalysis;
  try { a = analyzeBacktest(r, id, now); }
  catch (e) {
    a = { id, createdAt: now, version: '1.7.0-observational-1', status: 'failed', error: e instanceof Error ? e.message : 'Analyse fehlgeschlagen', input: { position: r.position, snapshot: r.snapshot, trades: r.trades }, result: null, factors: [], observations: [], explanations: [], expectations: [], limitations: [], hypotheses: [] };
  }
  const saved = versions();
  saved[key] = [...(saved[key] ?? []), a];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  // Caller supplies the published state without already-merged local versions.
  return mergeLocalBacktest(state);
}
