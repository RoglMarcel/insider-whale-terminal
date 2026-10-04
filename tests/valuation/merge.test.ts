import { expect, it } from 'vitest';
import { mergeValuations } from '../../src/lib/valuation/merge';
import { validateDocument } from '../../src/lib/valuation/validate';
import baseline from '../../data/valuation-baseline.json';

it('preserves verified dated observations on rejected refreshes and prefers newer observations without changing their dates', () => {
  const seed = validateDocument(baseline);
  const empty = { schemaVersion: 1 as const, generatedAt: '2026-10-04', stocks: {} };
  expect(mergeValuations(seed, empty).stocks).toEqual(seed.stocks);
  const old = seed.stocks.AAPL[0];
  const newer = { ...old, fetchedAt: '2026-10-04', priceAsOf: '2026-10-02', price: 334 };
  const updated = mergeValuations(seed, { ...empty, stocks: { AAPL: [newer] } });
  expect(updated.stocks.AAPL.find(x => x.provider === old.provider)).toEqual(newer);
  expect(updated.stocks.AAPL).toHaveLength(2);
  expect(mergeValuations(updated, { ...empty, stocks: { AAPL: [old] } }).stocks).toEqual(updated.stocks);
});
