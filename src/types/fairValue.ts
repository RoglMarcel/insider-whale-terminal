export interface FundamentalDatum {
  value: number;
  source: string;
  fetchedAt: string;
  /** Reporting/valuation date, never substituted with the download date. */
  asOf?: string | null;
  period?: 'TTM' | 'FY' | 'forecast' | 'spot' | 'unknown';
  currency?: string;
  unit?: 'currency' | 'currency/share' | 'shares' | 'ratio' | 'decimal' | 'flag';
  origin?: 'reported' | 'estimate' | 'derived' | 'assumption' | 'fallback' | 'unknown';
  originalValue?: string;
  derivation?: string;
  dependencies?: string[];
  splitAdjustedAsOf?: string;
}

export interface FairValueResult {
  version: 1 | 2 | 3;
  methodology?: 4;
  qualityReasons?: string[];
  missingQualityInputs?: string[];
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
  models: { name: string; value: number | null; reason?: string; status?: 'calculated' | 'missing-inputs' | 'unsuitable'; missingInputs?: string[] }[];
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
