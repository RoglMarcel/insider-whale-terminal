export interface FundamentalDatum {
  value: number;
  source: string;
  fetchedAt: string;
}

export interface FairValueResult {
  version: 1 | 2 | 3;
  calculatedAt: string;
  currency: string;
  quote?: { source: string; asOf: string; exchange: string; name: string; session: 'regular'; delayed: boolean };
  scenarios?: { name: 'bear' | 'base' | 'bull'; value: number; growth: number; discount: number; terminal: number }[];
  level: 1 | 2 | 3;
  externalComparisons?: ExternalFairValue[];
  status: 'estimated' | 'fallback' | 'unavailable';
  price: number | null;
  low: number | null;
  high: number | null;
  fairValue: number | null;
  upsidePct: number | null;
  /** Market price relative to central fair value: positive means expensive. */
  mispricingPct?: number | null;
  safetyMarginMet?: boolean;
  marginOfSafety: number;
  entryPrice: number | null;
  weight: number;
  multiplier: number;
  recommendation: 'undervalued' | 'watch' | 'overvalued' | 'insufficient-data';
  inputs: Record<string, FundamentalDatum>;
  assumptions: string[];
  warnings: string[];
  models: { name: string; value: number | null; reason?: string }[];
}

export interface ExternalFairValue {
  provider: 'alphaspread' | 'gurufocus' | 'fairvaluecalculator' | 'valueinvesting'; // legacy snapshots only for ValueInvesting
  method: string;
  url: string;
  fetchedAt: string;
  asOf?: string;
  currency: string;
  value: number | null;
  status: 'available' | 'blocked' | 'cooldown' | 'unavailable' | 'unsupported';
  retryAt?: string;
  reason?: string;
  /** Our value relative to the provider, with the provider as denominator. */
  modelDifferencePct?: number | null;
  marketMispricingPct?: number | null;
}
