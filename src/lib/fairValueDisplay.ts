import type { FairValueResult } from '@/types/fairValue';
import { calculateFairValue } from '../../electron/fairValue';

export function upgradeFairValue(value: FairValueResult): FairValueResult {
  value = { ...value, externalComparisons: value.externalComparisons?.filter(c => c.provider === 'fairvaluecalculator' || c.provider === 'alphaspread') };
  // Normalize persisted stage-4 snapshots using their original observation date.
  if (value.version === 3 && Number(value.level) <= 3) return value;
  const inputs = { ...value.inputs };
  if (value.currency === 'USD' && value.quote && !value.quote.exchange.match(/OTC/i)) inputs.usdRiskModel = { value: 1, source: value.quote.source, fetchedAt: value.calculatedAt };
  const next = calculateFairValue(inputs, Date.parse(value.calculatedAt), value.warnings.filter(w => !w.startsWith('Model corridor is')));
  return { ...next, currency: value.currency, quote: value.quote, externalComparisons: value.externalComparisons };
}

export function valuationComparison(value?: FairValueResult) {
  if (!value || value.fairValue == null || value.fairValue <= 0 || value.price == null || value.price <= 0) return null;
  return (value.price / value.fairValue - 1) * 100;
}
