import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { scoreTicker } from '../electron/scoring';
import golden from './golden-scores.json';

/**
 * GOLDEN FILE — a fixed set of realistic aggregates and the scores the model
 * produces for them. Its job is not to say whether a score is RIGHT; it is to
 * make every model change VISIBLE. `verify:scoring` checks the individual
 * factors; this checks the composite end to end.
 *
 * When a model change is intended, re-generate with:
 *   npx vitest run tests/golden.test.ts -u    (or set UPDATE_GOLDEN=1)
 * and explain the diff in the commit message.
 *
 * Every aggregate is dated relative to a FROZEN clock, so the file does not rot.
 */
import { CASES, FROZEN } from './golden-cases';

type GoldenRow = { name: string; score: number; tier: string; raw: number; confidence: number };

describe('golden scores', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN));
  });
  afterAll(() => vi.useRealTimers());

  const actual: GoldenRow[] = [];

  it('produces the recorded scores for every fixed case', () => {
    for (const { name, agg } of CASES) {
      const s = scoreTicker(agg);
      actual.push({
        name,
        score: s.score,
        tier: s.convictionLevel,
        raw: Math.round(s.breakdown.rawScore * 1000) / 1000,
        confidence: s.breakdown.confidence ?? 0,
      });
    }
    expect(actual).toEqual(golden as GoldenRow[]);
  });

  it('the golden file covers every case (no silent drift in coverage)', () => {
    expect((golden as GoldenRow[]).map((g) => g.name)).toEqual(CASES.map((c) => c.name));
  });
});
