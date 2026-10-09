import type { Signal, PortfolioConfig, PortfolioPosition, TickerAggregate, ScoringConfig, VixQuote, InsiderTrackRecord } from './index';

export interface DecisionContext {
  scoringAt: string;
  aggregate: TickerAggregate;
  scoringConfig: ScoringConfig;
  shadowConfig: ScoringConfig | null;
  vixQuote?: VixQuote | null;
  trackRecords?: InsiderTrackRecord[];
}

export interface DecisionEnvelope {
  key: string;
  capturedAt: string;
  logicVersion: string;
  signal: Signal;
  parameters: Record<string, unknown>;
  context: DecisionContext | null;
}
export interface BacktestSnapshot {
  capturedAt: string;
  provenance: 'original' | 'missing';
  missingReason: string | null;
  decision: DecisionEnvelope | null;
  config: PortfolioConfig;
  execution: PortfolioPosition;
  currency: 'USD';
  fees: number | null;
  slippageBps: number;
}
export interface BacktestTrade {
  key: string;
  side: 'buy' | 'sell';
  recordedAt: string;
  date: string;
  price: number;
  shares: number;
  value: number;
  fees: number | null;
  reason: string | null;
}
export interface BacktestAnalysis {
  id: string;
  createdAt: string;
  version: string;
  status: 'complete' | 'failed';
  error: string | null;
  input: { snapshot: BacktestSnapshot; trades: BacktestTrade[]; position: PortfolioPosition };
  result: { holdDays: number; pnlUsd: number; pnlEur: number | null; returnPct: number; benchmarkPct: number | null; alpha: number | null } | null;
  factors: { name: string; value: number }[];
  observations: string[];
  expectations: { statement: string; verdict: 'confirmed' | 'contradicted' | 'unknown'; evidence: string }[];
  explanations: string[];
  limitations: string[];
  hypotheses: string[];
}
export interface BacktestRecord {
  key: string;
  portfolio: string;
  portfolioId: string;
  strategy: string;
  position: PortfolioPosition;
  snapshot: BacktestSnapshot;
  trades: BacktestTrade[];
  analyses: BacktestAnalysis[];
  status: 'open' | 'pending' | 'complete' | 'failed';
  replayChanged: boolean;
  replayChanges: { recordedAt: string; position: PortfolioPosition }[];
}
export interface BacktestState {
  schemaVersion: 1;
  generatedAt: string;
  records: BacktestRecord[];
  readOnly: boolean;
  localError?: string;
}
