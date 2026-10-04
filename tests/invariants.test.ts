import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scoreTicker,
  scoreOptionsDetailed,
  scoreOneOption,
  getVixMultiplier,
  getTrackRecordMultiplier,
  getValuationMultiplier,
  getClusterMultiplier,
  getInsiderTimingMultiplier,
  getOptionsTimingMultiplier,
  getPoliticianScore,
  computeConfidence,
  CORROBORATION_GATE,
} from '../electron/scoring';
import { getFreshnessMultiplier, type TickerAggregate, type OptionsActivity, type RawInsiderTrade } from '../src/types';
import { aggregate, trade, option, politician, ymd, snapshot } from './helpers';

/**
 * The properties the model CLAIMS to have. Each of these was written because a
 * comment asserted it and nothing enforced it.
 */

// A small deterministic pseudo-random generator so the property sweeps are
// reproducible — a flaky invariant test is worse than none.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const ROLES = ['Chief Executive Officer', 'CFO', 'Director', '10% Owner', 'VP Sales', '', 'Founder'];
const TYPES = ['P - Purchase', 'A - Award', 'S - Sale', '10b5-1 Purchase', 'Option Exercise', '', 'Gift'];
const SENTIMENTS: OptionsActivity['sentiment'][] = ['bullish', 'bearish'];

function randomAggregate(r: () => number): TickerAggregate {
  const nTrades = Math.floor(r() * 5);
  const nOptions = Math.floor(r() * 5);
  const trades: RawInsiderTrade[] = Array.from({ length: nTrades }, (_, i) =>
    trade({
      insiderName: `Person ${Math.floor(r() * 4)}`,
      role: ROLES[Math.floor(r() * ROLES.length)],
      transactionType: TYPES[Math.floor(r() * TYPES.length)],
      tradeDate: r() < 0.1 ? 'garbage' : ymd(Math.floor(r() * 60)),
      shares: Math.floor(r() * 1e6),
      price: r() * 500,
      value: r() * 20_000_000,
      source: i % 2 ? 'edgar' : 'openinsider',
    }),
  );
  const options: OptionsActivity[] = Array.from({ length: nOptions }, () =>
    option({
      sentiment: SENTIMENTS[Math.floor(r() * 2)],
      type: r() < 0.5 ? 'call' : 'put',
      notional: r() * 30_000_000,
      premiumTotal: r() * 30_000_000,
      isSweep: r() < 0.4,
      dte: Math.floor(r() * 400) - 30,
      otmPercent: r() * 60 - 30,
      volOiRatio: r() * 20,
      scrapedAt: new Date(Date.now() - r() * 5 * 86_400_000).toISOString(),
    }),
  );
  return aggregate({
    trades,
    options,
    marketCap: r() < 0.5 ? undefined : r() * 2e12,
    daysToEarnings: r() < 0.3 ? undefined : Math.floor(r() * 90) - 10,
    vix: r() < 0.3 ? undefined : r() * 60,
    bestAccuracy3m: r() < 0.4 ? undefined : r(),
    upsidePct: r() < 0.6 ? undefined : r() * 120 - 60,
    politicianTrades: r() < 0.7 ? [] : [politician(), politician({ politician: 'B Member' })],
    sourceCount: 1 + Math.floor(r() * 3),
  });
}

/** Absurd but type-valid inputs, on top of the random sweep. */
const ABSURD: TickerAggregate[] = [
  aggregate(),
  aggregate({ trades: [trade({ value: NaN, shares: NaN, price: NaN })] }),
  aggregate({ trades: [trade({ value: Infinity })] }),
  aggregate({ trades: [trade({ value: -1 })] }),
  aggregate({ trades: [trade({ tradeDate: '' })] }),
  aggregate({ trades: [trade({ tradeDate: '2099-01-01' })] }),
  aggregate({ trades: [trade({ insiderName: '' })] }),
  aggregate({ options: [option({ notional: NaN, premiumTotal: NaN })] }),
  aggregate({ options: [option({ notional: Infinity, premiumTotal: Infinity })] }),
  aggregate({ options: [option({ dte: NaN, otmPercent: NaN, volOiRatio: NaN })] }),
  aggregate({ vix: NaN }),
  aggregate({ vix: Infinity }),
  aggregate({ bestAccuracy3m: NaN }),
  aggregate({ marketCap: NaN }),
  aggregate({ marketCap: 0 }),
  aggregate({ daysToEarnings: NaN }),
  aggregate({ upsidePct: NaN }),
  aggregate({ trades: [trade()], vix: NaN, bestAccuracy3m: NaN, marketCap: NaN, daysToEarnings: NaN, upsidePct: NaN }),
];

function allAggregates(): TickerAggregate[] {
  const r = rng(20260822);
  return [...ABSURD, ...Array.from({ length: 400 }, () => randomAggregate(r))];
}

describe('INVARIANT — finalScore is always a finite number in [0, 100]', () => {
  it('holds for absurd and randomized inputs alike', () => {
    for (const agg of allAggregates()) {
      const s = scoreTicker(agg);
      expect(Number.isFinite(s.score), `score for ${JSON.stringify(agg.ticker)}`).toBe(true);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(['HIGH', 'WATCH', 'LOW']).toContain(s.convictionLevel);
    }
  });
});

describe('INVARIANT — no NaN or Infinity anywhere in the breakdown', () => {
  it('every numeric breakdown field is finite', () => {
    const numericKeys = [
      'rankWeight', 'dollarVolumePoints', 'typeModifier', 'clusterMultiplier', 'timingMultiplier',
      'optionsScore', 'optionsTimingMultiplier', 'freshnessMultiplier', 'vixMultiplier',
      'trackRecordMultiplier', 'comboBonus', 'optionsBonus', 'rawScore', 'maxPossibleRaw',
      'normalizedScore', 'confidence', 'politicianScore',
    ] as const;
    for (const agg of allAggregates()) {
      const b = scoreTicker(agg).breakdown;
      for (const k of numericKeys) {
        const v = b[k];
        if (v == null) continue;
        expect(Number.isFinite(v), `${k} = ${v}`).toBe(true);
      }
      // signalAgeDays is nullable but must never be NaN.
      expect(b.signalAgeDays === null || Number.isFinite(b.signalAgeDays)).toBe(true);
      expect(b.notes.every((n) => typeof n === 'string' && !n.includes('NaN'))).toBe(true);
    }
  });
});

describe('INVARIANT — every multiplier is exactly 1.0 on neutral input', () => {
  it('neutral means: nothing known, nothing special', () => {
    expect(getVixMultiplier(undefined)).toBe(1.0);
    expect(getTrackRecordMultiplier(undefined)).toBe(1.0);
    expect(getValuationMultiplier(undefined)).toBe(1.0);
    expect(getClusterMultiplier(1)).toBe(1.0);
    expect(getInsiderTimingMultiplier(undefined, false).multiplier).toBe(1.0);
    expect(getOptionsTimingMultiplier(undefined)).toBe(1.0);
    expect(getFreshnessMultiplier(0)).toBe(1.0);
  });
  it('a fully neutral aggregate produces neutral multipliers in the breakdown', () => {
    const b = scoreTicker(aggregate({ trades: [trade({ tradeDate: ymd(0) })] })).breakdown;
    expect(b.clusterMultiplier).toBe(1.0);
    expect(b.timingMultiplier).toBe(1.0);
    expect(b.optionsTimingMultiplier).toBe(1.0);
    expect(b.vixMultiplier).toBe(1.0);
    expect(b.trackRecordMultiplier).toBe(1.0);
    expect(b.freshnessMultiplier).toBe(1.0);
    expect(b.typeModifier).toBe(1.0);
  });
});

describe('INVARIANT — scoring is deterministic and side-effect free', () => {
  afterEach(() => vi.useRealTimers());

  it('two calls on the same aggregate give bit-identical results (fixed clock)', () => {
    // The options leg decays against the wall clock (`optionsAge` is measured
    // from `scrapedAt` to now), so "deterministic" can only mean "for a fixed
    // instant". Freeze it, then demand bit equality — which is what catches an
    // accidental mutation or a Math.random creeping in.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T18:00:00Z'));
    for (const agg of allAggregates()) {
      const a = scoreTicker(agg);
      const b = scoreTicker(agg);
      expect(b.score).toBe(a.score);
      expect(b.breakdown.rawScore).toBe(a.breakdown.rawScore);
      expect(JSON.stringify(b.breakdown)).toBe(JSON.stringify(a.breakdown));
    }
  });
  it('the input aggregate is never mutated', () => {
    for (const agg of allAggregates()) {
      const before = snapshot(agg);
      scoreTicker(agg);
      expect(snapshot(agg)).toBe(before);
    }
  });
  it('a shadow-config call right after a live call cannot change the live result', () => {
    // Regression: the orchestrator scores each aggregate twice on the SAME
    // object, and the first call used to leave it in a state the second rejected.
    const agg = aggregate({ trades: [trade({ shares: 1, value: 5_000_000, price: undefined })] });
    const live1 = scoreTicker(agg).score;
    scoreTicker(agg, { freshnessDecayRate: 0.2, freshnessFloor: 0.1, comboBonus: 0, trackRecordSlope: 0.5, scoreHalfSaturation: 200, vixCap: 1.3 });
    const live2 = scoreTicker(agg).score;
    expect(live2).toBe(live1);
    expect(live1).toBeGreaterThan(0);
  });
});

describe('INVARIANT — scoreOptionsDetailed ≤ 2× the best single print per direction', () => {
  it('holds for randomized baskets', () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const opts = Array.from({ length: 1 + Math.floor(r() * 12) }, () =>
        option({
          sentiment: SENTIMENTS[Math.floor(r() * 2)],
          notional: r() * 30_000_000,
          premiumTotal: r() * 30_000_000,
          isSweep: r() < 0.5,
          dte: Math.floor(r() * 300),
          otmPercent: r() * 50,
          volOiRatio: r() * 20,
        }),
      );
      const bestBull = Math.max(0, ...opts.filter((o) => o.sentiment === 'bullish').map(scoreOneOption));
      const bestBear = Math.max(0, ...opts.filter((o) => o.sentiment === 'bearish').map(scoreOneOption));
      const score = scoreOptionsDetailed(opts).score;
      expect(score).toBeLessThanOrEqual(2 * bestBull + 1e-9);
      expect(score).toBeGreaterThanOrEqual(-2 * bestBear - 1e-9);
    }
  });
});

describe('INVARIANT — monotonicity in every factor that claims to be monotone', () => {
  /** Score the same aggregate with one field swapped. */
  const scoreWith = (base: TickerAggregate, patch: Partial<TickerAggregate>) =>
    scoreTicker({ ...base, ...patch, trades: base.trades.map((t) => ({ ...t })), options: base.options.map((o) => ({ ...o })) }).score;

  const bases: TickerAggregate[] = [
    aggregate({ trades: [trade({ value: 600_000 })] }),
    aggregate({ trades: [trade({ value: 600_000 })], options: [option({ premiumTotal: 3_000_000, notional: 3_000_000 })] }),
    // The case that used to invert: a bearish options leg big enough to make the
    // leg sum negative, plus a politician score added afterwards.
    aggregate({
      trades: [trade({ value: 20_000 })],
      options: [option({ type: 'put', sentiment: 'bearish', premiumTotal: 11_000_000, notional: 11_000_000, isSweep: true, dte: 10, otmPercent: 20, volOiRatio: 12 })],
      politicianTrades: [politician(), politician({ politician: 'B Member' }), politician({ politician: 'C Member' })],
    }),
  ];

  it('is non-decreasing in the insider track record', () => {
    for (const base of bases) {
      let last = -Infinity;
      for (const acc of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) {
        const s = scoreWith(base, { bestAccuracy3m: acc });
        expect(s, `acc=${acc}`).toBeGreaterThanOrEqual(last - 1e-9);
        last = s;
      }
    }
  });
  it('is non-decreasing in valuation upside', () => {
    for (const base of bases) {
      let last = -Infinity;
      for (const up of [-60, -30, -25, 0, 15, 40, 80]) {
        const s = scoreWith(base, { upsidePct: up });
        expect(s, `upside=${up}`).toBeGreaterThanOrEqual(last - 1e-9);
        last = s;
      }
    }
  });
  it('is non-decreasing in VIX', () => {
    for (const base of bases) {
      let last = -Infinity;
      for (const vix of [10, 20, 25, 30, 35, 50]) {
        const s = scoreWith(base, { vix });
        expect(s, `vix=${vix}`).toBeGreaterThanOrEqual(last - 1e-9);
        last = s;
      }
    }
  });
  it('is non-decreasing in the number of insiders buying', () => {
    for (const value of [200_000, 1_000_000]) {
      let last = -Infinity;
      for (let n = 1; n <= 6; n++) {
        const trades = Array.from({ length: n }, (_, i) => trade({ insiderName: `Person ${i}`, value, role: 'Director' }));
        const s = scoreTicker(aggregate({ trades })).score;
        expect(s, `n=${n}, value=${value}`).toBeGreaterThanOrEqual(last - 1e-9);
        last = s;
      }
    }
  });
  it('is non-decreasing in the size of the buy', () => {
    let last = -Infinity;
    for (const value of [50_000, 100_000, 500_000, 1_000_000, 5_000_000, 20_000_000]) {
      const s = scoreTicker(aggregate({ trades: [trade({ value })] })).score;
      expect(s, `value=${value}`).toBeGreaterThanOrEqual(last - 1e-9);
      last = s;
    }
  });
  it('is non-INCREASING in signal age', () => {
    let last = Infinity;
    for (const age of [0, 1, 3, 7, 14, 30]) {
      const s = scoreTicker(aggregate({ trades: [trade({ value: 1_000_000, tradeDate: ymd(age) })] })).score;
      expect(s, `age=${age}`).toBeLessThanOrEqual(last + 1e-9);
      last = s;
    }
  });
  it('is non-decreasing in the bullish options premium', () => {
    let last = -Infinity;
    for (const premium of [300_000, 600_000, 1_500_000, 3_000_000, 6_000_000, 12_000_000]) {
      const s = scoreTicker(aggregate({ options: [option({ premiumTotal: premium, notional: premium })] })).score;
      expect(s, `premium=${premium}`).toBeGreaterThanOrEqual(last - 1e-9);
      last = s;
    }
  });
  it('adding a BEARISH print never raises the score', () => {
    const withoutBear = scoreTicker(aggregate({
      trades: [trade({ value: 1_000_000 })],
      options: [option({ premiumTotal: 3_000_000, notional: 3_000_000 })],
    })).score;
    const withBear = scoreTicker(aggregate({
      trades: [trade({ value: 1_000_000 })],
      options: [
        option({ premiumTotal: 3_000_000, notional: 3_000_000 }),
        option({ type: 'put', sentiment: 'bearish', premiumTotal: 3_000_000, notional: 3_000_000 }),
      ],
    })).score;
    expect(withBear).toBeLessThanOrEqual(withoutBear);
  });
});

describe('INVARIANT — corroboration can never lower a score, and is gated', () => {
  it('the soft multiplier only applies at or above the gate', () => {
    // Below the gate: the combo badge is set but the score is untouched.
    const weak = aggregate({
      trades: [trade({ value: 60_000, role: 'VP Sales' })],
      options: [option({ premiumTotal: 300_000, notional: 300_000 })],
    });
    const scored = scoreTicker(weak);
    expect(scored.comboSignal).toBe(true);
    expect(scored.breakdown.normalizedScore).toBeLessThan(CORROBORATION_GATE);
    expect(scored.breakdown.comboBonus).toBe(0);
  });
  it('a combo never DECREASES the score', () => {
    const withoutCombo = scoreTicker(aggregate({ trades: [trade({ value: 5_000_000 })] })).score;
    const withCombo = scoreTicker(aggregate({
      trades: [trade({ value: 5_000_000 })],
      options: [option({ premiumTotal: 300_000, notional: 300_000 })],
    })).score;
    expect(withCombo).toBeGreaterThanOrEqual(withoutCombo);
  });
});

describe('INVARIANT — excluded transaction types contribute nothing', () => {
  it('an award-only aggregate scores 0 and reports 0 volume', () => {
    const z = scoreTicker(aggregate({ trades: [trade({ transactionType: 'A - Award', value: 9_000_000 })] }));
    expect(z.score).toBe(0);
    expect(z.totalDollarVolume).toBe(0);
    expect(z.insiderCount).toBe(0);
  });
  it('a sale never adds to the score', () => {
    const buyOnly = scoreTicker(aggregate({ trades: [trade({ value: 1_000_000 })] })).score;
    const buyPlusSale = scoreTicker(aggregate({
      trades: [trade({ value: 1_000_000 }), trade({ insiderName: 'Other', transactionType: 'S - Sale', value: 9_000_000 })],
    })).score;
    expect(buyPlusSale).toBeLessThanOrEqual(buyOnly);
  });
});

describe('INVARIANT — the politician leg', () => {
  it('is never negative', () => {
    const r = rng(99);
    for (let i = 0; i < 100; i++) {
      const trades = Array.from({ length: 1 + Math.floor(r() * 6) }, () =>
        politician({
          politician: `M${Math.floor(r() * 4)}`,
          transactionType: r() < 0.5 ? 'buy' : 'sell',
          amountMidpoint: r() * 2_000_000,
          daysToDisclose: Math.floor(r() * 90),
          tradeDate: ymd(Math.floor(r() * 120)),
        }),
      );
      for (const mode of ['live', 'legacy'] as const) {
        const s = getPoliticianScore(trades, { mode }).score;
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('a lone print does not move the live score, but a cluster does', () => {
    expect(getPoliticianScore([politician()]).score).toBe(0);
    expect(getPoliticianScore([politician(), politician({ politician: 'B Member' })]).score).toBeGreaterThan(0);
  });
  it('an aligned insider buy unlocks a lone print', () => {
    const insiderTrades = [trade({ transactionType: 'P - Purchase', tradeDate: ymd(1) })];
    expect(getPoliticianScore([politician()], { mode: 'live', insiderTrades }).score).toBeGreaterThan(0);
  });
});

describe('INVARIANT — computeConfidence stays in [0, 100]', () => {
  it('holds across the random sweep', () => {
    for (const agg of allAggregates()) {
      const c = computeConfidence(agg, agg.trades);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(100);
    }
  });
});

/**
 * The breakdown is not decoration — it is the ONLY record of how a score was
 * reached, and `signal_outcomes` keeps nothing else. If a factor scales the
 * composite but is not a breakdown field, the stored history silently stops
 * being reproducible: that is exactly how `valuationMultiplier` went missing,
 * and it stayed invisible until a re-score tried to rebuild an old row and
 * landed 10% off. Anything that multiplies the composite has to appear here.
 *
 * Restricted to aggregates without options, because the options leg decays on
 * its own clock and that clock is deliberately not a breakdown field.
 */
describe('INVARIANT — the breakdown can reproduce its own rawScore', () => {
  it('holds for insider-only aggregates in every valuation state', () => {
    for (const up of [undefined, -60, -30, -25, 0, 15, 20, 50]) {
      for (const agg of allAggregates()) {
        if (agg.options.length) continue;
        const b = scoreTicker({ ...agg, upsidePct: up }).breakdown;
        const insiderRaw =
          b.rankWeight * b.dollarVolumePoints * b.typeModifier * b.clusterMultiplier * b.timingMultiplier * b.vixMultiplier;
        const expected =
          insiderRaw * b.freshnessMultiplier * b.trackRecordMultiplier * b.valuationMultiplier + (b.politicianScore ?? 0);
        const tol = 1e-9 * Math.max(1, Math.abs(b.rawScore));
        expect(Math.abs(b.rawScore - expected), `upsidePct=${up} ticker=${agg.ticker}`).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('records the valuation multiplier instead of folding it in silently', () => {
    const base = aggregate({ trades: [trade({ role: 'Chief Executive Officer', value: 800_000, tradeDate: ymd(0) })] });
    expect(scoreTicker({ ...base, upsidePct: 50 }).breakdown.valuationMultiplier).toBe(1.15);
    expect(scoreTicker({ ...base, upsidePct: 20 }).breakdown.valuationMultiplier).toBe(1.08);
    expect(scoreTicker({ ...base, upsidePct: -60 }).breakdown.valuationMultiplier).toBe(0.9);
    expect(scoreTicker(base).breakdown.valuationMultiplier).toBe(1);
  });
});
