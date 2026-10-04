import { describe, it, expect } from 'vitest';
import {
  earnsFinanceTimingBonus,
  getRankWeight,
  UNKNOWN_ROLE_WEIGHT,
  getDollarVolumePoints,
  getClusterMultiplier,
  getInsiderTimingMultiplier,
  getOptionsTimingMultiplier,
  getVixMultiplier,
  getTrackRecordMultiplier,
  getValuationMultiplier,
  scoreOneOption,
  scoreOptionsDetailed,
  isFinanceInsider,
  getConvictionLevel,
  SCORE_HALF_SATURATION,
  MAX_POSSIBLE_RAW,
} from '../electron/scoring';
import {
  getFreshnessMultiplier,
  getFreshnessLevel,
  shrunkAccuracy,
  MAX_INSIDER_TIMING_MULT,
  MAX_SINGLE_OPTION_POINTS,
  MAX_OPTIONS_SCORE_TOTAL,
  MAX_OPTION_BASE_POINTS,
  CONVICTION_THRESHOLDS,
} from '../src/types';
import { option, EPS } from './helpers';

// ──────────────────────────────────────────────────────────────────────────
// Step 1 — rank weight
// ──────────────────────────────────────────────────────────────────────────

describe('getRankWeight', () => {
  const cases: [string, number, string][] = [
    ['Chief Executive Officer', 10, 'exec'],
    ['CEO', 10, 'exec'],
    ['Executive Chairman', 10, 'exec'],
    ['Chief Financial Officer', 8, 'cfo'],
    ['CFO', 8, 'cfo'],
    ['COO', 8, 'cfo'],
    ['President', 8, 'cfo'],
    ['Pres', 8, 'cfo'],
    ['Founder', 8, 'cfo'],
    ['Chief Technology Officer', 6, 'csuite'],
    ['Chairman', 6, 'csuite'],
    ['COB', 6, 'csuite'],
    ['Chief Legal Officer', 6, 'csuite'],
    ['10% Owner', 5, 'director'],
    ['Beneficial Owner', 5, 'director'],
    ['Director', 4, 'director'],
    ['Dir', 4, 'director'],
    ['EVP', 3, 'vp'],
    ['Vice President', 3, 'vp'],
    ['General Counsel', 3, 'vp'],
    ['Treasurer', 3, 'vp'],
    ['', 4, 'unknown'],
    ['Employee', 4, 'unknown'],
  ];
  for (const [role, weight, category] of cases) {
    it(`${JSON.stringify(role)} → ${weight} (${category})`, () => {
      expect(getRankWeight(role)).toEqual({ weight, category });
    });
  }

  it('a Vice President is never mistaken for the President', () => {
    expect(getRankWeight('Executive Vice President').weight).toBe(3);
    expect(getRankWeight('SVP, Finance').weight).toBe(3);
  });
  it('"Dir, 10%" takes the higher of the two weights', () => {
    expect(getRankWeight('Dir, 10%').weight).toBe(5);
  });
  it('multiple roles resolve to the highest rank, order-independently', () => {
    expect(getRankWeight('CEO, CFO').weight).toBe(10);
    expect(getRankWeight('CFO, CEO').weight).toBe(10);
  });
  it('null/undefined do not throw', () => {
    expect(getRankWeight(undefined as unknown as string).weight).toBe(4);
  });

  it('an unparsed role is UNKNOWN, not the lowest rank', () => {
    // The old floor of 1 scored a missing title like the most junior insider in
    // the company. 4 is the modal recognised rank in the stored history.
    for (const r of ['', '   ', 'Employee', 'Consultant', 'Shareholder']) {
      expect(getRankWeight(r).weight).toBe(UNKNOWN_ROLE_WEIGHT);
      expect(getRankWeight(r).category).toBe('unknown');
    }
    // …but it never outranks a role we DID recognise.
    expect(UNKNOWN_ROLE_WEIGHT).toBeLessThanOrEqual(getRankWeight('10% Owner').weight);
    expect(UNKNOWN_ROLE_WEIGHT).toBeLessThan(getRankWeight('CFO').weight);
    expect(UNKNOWN_ROLE_WEIGHT).toBeLessThan(getRankWeight('CEO').weight);
  });
  it('never exceeds the ceiling assumed by MAX_POSSIBLE_RAW', () => {
    for (const r of cases.map((c) => c[0])) expect(getRankWeight(r).weight).toBeLessThanOrEqual(10);
  });
});

describe('earnsFinanceTimingBonus — the rank/finance double-count', () => {
  it('withholds the bonus where the RANK already pays for being finance', () => {
    // A CFO is weighted 8 against a director's 4 precisely because they see the
    // numbers first; charging the ×1.3 pre-earnings bonus as well counted that
    // one fact twice in the same multiplicative chain.
    for (const r of ['CFO', 'Chief Financial Officer', 'CFO, Director']) {
      expect(isFinanceInsider(r)).toBe(true);
      expect(getRankWeight(r).category).toBe('cfo');
      expect(earnsFinanceTimingBonus(r)).toBe(false);
    }
  });

  it('keeps the bonus where the rank does NOT encode it', () => {
    // Ranked like any other officer, so "finance insider days before earnings"
    // is genuinely new information about them.
    for (const r of ['Treasurer', 'VP, Finance', 'Chief Accounting Officer', 'Controller']) {
      expect(isFinanceInsider(r)).toBe(true);
      expect(earnsFinanceTimingBonus(r)).toBe(true);
    }
  });

  it('never fires for a non-finance role', () => {
    for (const r of ['CEO', 'Director', 'CTO', '']) expect(earnsFinanceTimingBonus(r)).toBe(false);
  });
});

describe('isFinanceInsider', () => {
  for (const r of ['CFO', 'Chief Financial Officer', 'VP Finance', 'Audit Committee', 'Treasurer', 'Controller', 'Chief Accounting Officer']) {
    it(`${JSON.stringify(r)} → true`, () => expect(isFinanceInsider(r)).toBe(true));
  }
  for (const r of ['CEO', 'Director', '', 'CTO']) {
    it(`${JSON.stringify(r)} → false`, () => expect(isFinanceInsider(r)).toBe(false));
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Step 2 — dollar volume, both branches, every threshold from both sides
// ──────────────────────────────────────────────────────────────────────────

describe('getDollarVolumePoints — absolute branch (no market cap)', () => {
  const rungs: [number, number, number][] = [
    // [threshold, points at T, points at T-1]
    [5_000_000, 20, 14],
    [1_000_000, 14, 10],
    [500_000, 10, 5],
    [100_000, 5, 1],
  ];
  for (const [t, atT, belowT] of rungs) {
    it(`$${t.toLocaleString()} → ${atT}, one cent below → ${belowT}`, () => {
      expect(getDollarVolumePoints(t)).toBe(atT);
      expect(getDollarVolumePoints(t - 0.01)).toBe(belowT);
    });
  }
  it('every rung uses >= (regression: the top rung used >)', () => {
    expect(getDollarVolumePoints(5_000_000)).toBe(getDollarVolumePoints(5_000_001));
  });
  it('zero and negative fall to the floor', () => {
    expect(getDollarVolumePoints(0)).toBe(1);
    expect(getDollarVolumePoints(-1_000_000)).toBe(1);
  });
  it('non-finite input does not produce a non-finite result', () => {
    expect(getDollarVolumePoints(NaN)).toBe(1);
    expect(getDollarVolumePoints(Infinity)).toBe(1);
  });
});

describe('getDollarVolumePoints — market-cap-relative branch', () => {
  const cap = 1e9;
  const rungs: [number, number, number][] = [
    [0.005, 20, 14],
    [0.001, 14, 10],
    [0.0002, 10, 5],
    [0.00005, 5, 1],
  ];
  for (const [ratio, atT, belowT] of rungs) {
    it(`${(ratio * 100).toFixed(4)}% of cap → ${atT}, just below → ${belowT}`, () => {
      expect(getDollarVolumePoints(ratio * cap, cap)).toBe(atT);
      expect(getDollarVolumePoints(ratio * cap * (1 - 1e-6), cap)).toBe(belowT);
    });
  }
  it('a zero / negative / non-finite cap falls back to the absolute branch', () => {
    expect(getDollarVolumePoints(5_000_000, 0)).toBe(20);
    expect(getDollarVolumePoints(5_000_000, -1)).toBe(20);
    expect(getDollarVolumePoints(5_000_000, NaN)).toBe(20);
  });
  it('is monotone in the buy value for a fixed cap', () => {
    let last = 0;
    for (const v of [0, 1e4, 1e5, 5e5, 1e6, 5e6, 1e8]) {
      const p = getDollarVolumePoints(v, cap);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });
  it('is monotone NON-INCREASING in the cap for a fixed buy value', () => {
    let last = Infinity;
    for (const c of [1e8, 1e9, 1e10, 1e11, 1e12]) {
      const p = getDollarVolumePoints(5_000_000, c);
      expect(p).toBeLessThanOrEqual(last);
      last = p;
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Step 3 — cluster
// ──────────────────────────────────────────────────────────────────────────

describe('getClusterMultiplier', () => {
  it('matches the documented ladder', () => {
    expect(getClusterMultiplier(0)).toBe(1.0);
    expect(getClusterMultiplier(1)).toBe(1.0);
    expect(getClusterMultiplier(2)).toBe(1.5);
    expect(getClusterMultiplier(3)).toBe(2.0);
    expect(getClusterMultiplier(4)).toBe(3.0);
  });
  it('is capped at 4 insiders', () => {
    expect(getClusterMultiplier(5)).toBe(3.0);
    expect(getClusterMultiplier(1000)).toBe(3.0);
  });
  it('is monotone non-decreasing', () => {
    let last = 0;
    for (let n = 0; n <= 12; n++) {
      const m = getClusterMultiplier(n);
      expect(m).toBeGreaterThanOrEqual(last);
      last = m;
    }
  });
  it('non-finite input is neutral', () => {
    expect(getClusterMultiplier(NaN)).toBe(1.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Step 4 — earnings timing, both legs
// ──────────────────────────────────────────────────────────────────────────

describe('getInsiderTimingMultiplier', () => {
  it('neutral without an earnings date', () => {
    expect(getInsiderTimingMultiplier(undefined, false).multiplier).toBe(1.0);
    expect(getInsiderTimingMultiplier(undefined, true).multiplier).toBe(1.0);
  });
  it('a PAST earnings date is neutral', () => {
    expect(getInsiderTimingMultiplier(-1, true).multiplier).toBe(1.0);
  });
  it('thresholds from both sides', () => {
    expect(getInsiderTimingMultiplier(0, false).multiplier).toBe(1.8);
    expect(getInsiderTimingMultiplier(5, false).multiplier).toBe(1.8);
    expect(getInsiderTimingMultiplier(5 + EPS, false).multiplier).toBe(1.5);
    expect(getInsiderTimingMultiplier(15, false).multiplier).toBe(1.5);
    expect(getInsiderTimingMultiplier(15 + EPS, false).multiplier).toBe(1.3);
    expect(getInsiderTimingMultiplier(30, false).multiplier).toBe(1.3);
    expect(getInsiderTimingMultiplier(30 + EPS, false).multiplier).toBe(1.0);
  });
  it('the finance bonus applies only up to 15 days', () => {
    expect(getInsiderTimingMultiplier(5, true).multiplier).toBeCloseTo(2.34, 10);
    expect(getInsiderTimingMultiplier(15, true).multiplier).toBeCloseTo(1.95, 10);
    expect(getInsiderTimingMultiplier(16, true).multiplier).toBe(1.3);
  });
  it('the maximum equals MAX_INSIDER_TIMING_MULT', () => {
    let max = 0;
    for (let d = 0; d <= 60; d += 0.5) {
      max = Math.max(max, getInsiderTimingMultiplier(d, true).multiplier);
    }
    expect(max).toBeCloseTo(MAX_INSIDER_TIMING_MULT, 10);
  });
  it('non-finite input is neutral', () => {
    expect(getInsiderTimingMultiplier(NaN, true).multiplier).toBe(1.0);
  });
  it('emits a note only when a bonus applies', () => {
    expect(getInsiderTimingMultiplier(60, false).notes).toEqual([]);
    expect(getInsiderTimingMultiplier(3, false).notes.length).toBe(1);
    expect(getInsiderTimingMultiplier(3, true).notes.length).toBe(2);
  });
});

describe('getOptionsTimingMultiplier', () => {
  it('thresholds from both sides', () => {
    expect(getOptionsTimingMultiplier(undefined)).toBe(1.0);
    expect(getOptionsTimingMultiplier(-1)).toBe(1.0);
    expect(getOptionsTimingMultiplier(0)).toBe(2.0);
    expect(getOptionsTimingMultiplier(5)).toBe(2.0);
    expect(getOptionsTimingMultiplier(5 + EPS)).toBe(1.6);
    expect(getOptionsTimingMultiplier(15)).toBe(1.6);
    expect(getOptionsTimingMultiplier(15 + EPS)).toBe(1.3);
    expect(getOptionsTimingMultiplier(30)).toBe(1.3);
    expect(getOptionsTimingMultiplier(30 + EPS)).toBe(1.0);
  });
  it('non-finite input is neutral', () => {
    expect(getOptionsTimingMultiplier(NaN)).toBe(1.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Step 5 — options
// ──────────────────────────────────────────────────────────────────────────

describe('scoreOneOption — premium ladder', () => {
  const rungs: [number, number, number][] = [
    [10_000_000, MAX_OPTION_BASE_POINTS, 22],
    [5_000_000, 22, 18],
    [2_000_000, 18, 14],
    [1_000_000, 14, 9],
    [500_000, 9, 3],
  ];
  for (const [t, atT, belowT] of rungs) {
    it(`$${t.toLocaleString()} → ${atT}, one cent below → ${belowT}`, () => {
      expect(scoreOneOption(option({ premiumTotal: t, notional: t }))).toBe(atT);
      expect(scoreOneOption(option({ premiumTotal: t - 0.01, notional: t - 0.01 }))).toBe(belowT);
    });
  }
  it('all rungs use >= (regression: the top three used >)', () => {
    for (const t of [10_000_000, 5_000_000, 2_000_000]) {
      const at = scoreOneOption(option({ premiumTotal: t, notional: t }));
      const above = scoreOneOption(option({ premiumTotal: t + 1, notional: t + 1 }));
      expect(at).toBe(above);
    }
  });
  it('falls back to notional when premiumTotal is absent', () => {
    expect(scoreOneOption({ ...option(), premiumTotal: undefined, notional: 2_000_000 })).toBe(18);
  });
  it('missing premium earns no points', () => {
    expect(scoreOneOption({ ...option(), premiumTotal: undefined, notional: undefined as unknown as number })).toBe(0);
  });
});

describe('scoreOneOption — the four multipliers', () => {
  const base = option({ premiumTotal: 2_000_000, notional: 2_000_000, scrapedAt: new Date().toISOString() }); // 18 pts
  it('sweep ×1.6', () => expect(scoreOneOption({ ...base, isSweep: true })).toBeCloseTo(18 * 1.6, 10));
  it('DTE thresholds from both sides', () => {
    expect(scoreOneOption({ ...base, dte: 20 })).toBeCloseTo(18 * 1.5, 10);
    expect(scoreOneOption({ ...base, dte: 21 })).toBeCloseTo(18 * 1.2, 10);
    expect(scoreOneOption({ ...base, dte: 60 })).toBeCloseTo(18 * 1.2, 10);
    expect(scoreOneOption({ ...base, dte: 61 })).toBe(18);
    expect(scoreOneOption({ ...base, dte: 180 })).toBe(18);
    expect(scoreOneOption({ ...base, dte: 181 })).toBeCloseTo(18 * 0.8, 10);
  });
  it('an expired contract earns no near-term boost', () => {
    expect(scoreOneOption({ ...base, dte: -1 })).toBe(0);
    expect(scoreOneOption({ ...base, dte: 0 })).toBeCloseTo(18 * 1.5, 10);
  });
  it('OTM thresholds from both sides', () => {
    expect(scoreOneOption({ ...base, otmPercent: 15 })).toBeCloseTo(18 * 1.1, 10);
    expect(scoreOneOption({ ...base, otmPercent: 15 + EPS })).toBeCloseTo(18 * 1.4, 10);
    expect(scoreOneOption({ ...base, otmPercent: 5 })).toBeCloseTo(18 * 1.1, 10);
    expect(scoreOneOption({ ...base, otmPercent: 5 - EPS })).toBe(18);
    expect(scoreOneOption({ ...base, otmPercent: -20 })).toBe(18); // deep ITM: no boost
  });
  it('vol/OI thresholds from both sides', () => {
    expect(scoreOneOption({ ...base, volOiRatio: 10 })).toBeCloseTo(18 * 1.1, 10);
    expect(scoreOneOption({ ...base, volOiRatio: 10 + EPS })).toBeCloseTo(18 * 1.3, 10);
    expect(scoreOneOption({ ...base, volOiRatio: 3 })).toBeCloseTo(18 * 1.1, 10);
    expect(scoreOneOption({ ...base, volOiRatio: 3 - EPS })).toBe(18);
  });
  it('the documented worked example', () => {
    // 2.5M → 18, sweep 1.6, dte 14 → 1.5, otm 20 → 1.4, volOi 12 → 1.3
    expect(
      scoreOneOption(option({ premiumTotal: 2_500_000, notional: 2_500_000, isSweep: true, scrapedAt: new Date().toISOString(), dte: 14, otmPercent: 20, volOiRatio: 12 })),
    ).toBeCloseTo(78.624, 3);
  });
  it('the ceiling equals MAX_SINGLE_OPTION_POINTS', () => {
    const maxed = option({ premiumTotal: 1e9, notional: 1e9, isSweep: true, scrapedAt: new Date().toISOString(), dte: 1, otmPercent: 99, volOiRatio: 99 });
    expect(scoreOneOption(maxed)).toBeCloseTo(MAX_SINGLE_OPTION_POINTS, 6);
  });
  it('non-finite detail fields never produce NaN', () => {
    const evil = option({ premiumTotal: NaN, notional: NaN, dte: NaN, otmPercent: NaN, volOiRatio: NaN });
    expect(Number.isFinite(scoreOneOption(evil))).toBe(true);
  });
});

describe('scoreOptionsDetailed', () => {
  it('empty input scores zero', () => {
    expect(scoreOptionsDetailed([])).toEqual({ score: 0, notes: [] });
  });
  it('a single bullish print equals its own score', () => {
    const o = option({ premiumTotal: 2_000_000, notional: 2_000_000 });
    expect(scoreOptionsDetailed([o]).score).toBe(scoreOneOption(o));
  });
  it('a bearish print subtracts', () => {
    const o = option({ type: 'put', sentiment: 'bearish', premiumTotal: 2_000_000, notional: 2_000_000 });
    expect(scoreOptionsDetailed([o]).score).toBe(-scoreOneOption(o));
  });
  it('bull and bear net out', () => {
    const bull = option({ premiumTotal: 2_000_000, notional: 2_000_000 });
    const bear = option({ type: 'put', sentiment: 'bearish', premiumTotal: 2_000_000, notional: 2_000_000 });
    expect(scoreOptionsDetailed([bull, bear]).score).toBe(0);
  });
  it('the geometric tail stays strictly below 2× the best print per direction', () => {
    const one = option({ premiumTotal: 11_000_000, notional: 11_000_000 });
    const best = scoreOneOption(one);
    for (const n of [1, 2, 3, 5, 10, 50]) {
      const score = scoreOptionsDetailed(Array.from({ length: n }, () => one)).score;
      expect(score).toBeLessThan(2 * best);
      expect(score).toBeGreaterThanOrEqual(best);
    }
  });
  it('the bound holds regardless of input ORDER (the sum sorts descending)', () => {
    const a = option({ premiumTotal: 600_000, notional: 600_000 });
    const b = option({ premiumTotal: 11_000_000, notional: 11_000_000 });
    const c = option({ premiumTotal: 3_000_000, notional: 3_000_000 });
    const s1 = scoreOptionsDetailed([a, b, c]).score;
    const s2 = scoreOptionsDetailed([b, c, a]).score;
    const s3 = scoreOptionsDetailed([c, a, b]).score;
    expect(s1).toBeCloseTo(s2, 10);
    expect(s2).toBeCloseTo(s3, 10);
  });
  it('does NOT mutate the input array', () => {
    const arr = [
      option({ premiumTotal: 600_000, notional: 600_000 }),
      option({ premiumTotal: 11_000_000, notional: 11_000_000 }),
      option({ premiumTotal: 3_000_000, notional: 3_000_000 }),
    ];
    const before = JSON.stringify(arr);
    scoreOptionsDetailed(arr);
    expect(JSON.stringify(arr)).toBe(before);
  });
  it('the per-direction display ceiling matches MAX_OPTIONS_SCORE_TOTAL', () => {
    expect(MAX_OPTIONS_SCORE_TOTAL).toBeCloseTo(MAX_SINGLE_OPTION_POINTS * 2, 10);
    expect(MAX_OPTIONS_SCORE_TOTAL).toBeCloseTo(227.136, 3);
  });
  it('prints with no direction are ignored, not guessed', () => {
    const weird = { ...option(), sentiment: 'neutral' as unknown as 'bullish' };
    expect(scoreOptionsDetailed([weird]).score).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Context multipliers
// ──────────────────────────────────────────────────────────────────────────

describe('getVixMultiplier', () => {
  it('is neutral below the ramp and capped above it', () => {
    expect(getVixMultiplier(undefined)).toBe(1.0);
    expect(getVixMultiplier(0)).toBe(1.0);
    expect(getVixMultiplier(20)).toBe(1.0);
    expect(getVixMultiplier(35)).toBe(1.15);
    expect(getVixMultiplier(100)).toBe(1.15);
  });
  it('ramps linearly and continuously between 20 and 35', () => {
    expect(getVixMultiplier(20 + EPS)).toBeGreaterThan(1.0);
    expect(getVixMultiplier(27.5)).toBeCloseTo(1.075, 10);
    expect(getVixMultiplier(35 - 1e-9)).toBeCloseTo(1.15, 8);
  });
  it('honours a custom cap', () => {
    expect(getVixMultiplier(35, 1.4)).toBe(1.4);
    expect(getVixMultiplier(27.5, 1.4)).toBeCloseTo(1.2, 10);
  });
  it('is monotone non-decreasing', () => {
    let last = 0;
    for (let v = 0; v <= 60; v += 0.25) {
      const m = getVixMultiplier(v);
      expect(m).toBeGreaterThanOrEqual(last - 1e-12);
      last = m;
    }
  });
  it('a non-finite reading is neutral, never NaN', () => {
    expect(getVixMultiplier(NaN)).toBe(1.0);
    // Infinity is not a reading either — neutral, not "maximum fear".
    expect(getVixMultiplier(Infinity)).toBe(1.0);
    expect(getVixMultiplier(-Infinity)).toBe(1.0);
  });
});

describe('getTrackRecordMultiplier', () => {
  it('coin-flip and unknown are exactly neutral', () => {
    expect(getTrackRecordMultiplier(0.5)).toBe(1.0);
    expect(getTrackRecordMultiplier(undefined)).toBe(1.0);
  });
  it('matches the documented curve', () => {
    expect(getTrackRecordMultiplier(0.8)).toBeCloseTo(1.195, 10);
    expect(getTrackRecordMultiplier(0.3)).toBeCloseTo(0.87, 10);
  });
  it('clamps at both ends, at the derivable accuracies', () => {
    expect(getTrackRecordMultiplier(0.5 + 0.2 / 0.65)).toBeCloseTo(1.2, 10);
    expect(getTrackRecordMultiplier(1)).toBeCloseTo(1.2, 10);
    expect(getTrackRecordMultiplier(0.5 - 0.15 / 0.65)).toBeCloseTo(0.85, 10);
    expect(getTrackRecordMultiplier(0)).toBeCloseTo(0.85, 10);
  });
  it('is monotone non-decreasing in accuracy', () => {
    let last = 0;
    for (let a = 0; a <= 1.0001; a += 0.01) {
      const m = getTrackRecordMultiplier(a);
      expect(m).toBeGreaterThanOrEqual(last - 1e-12);
      last = m;
    }
  });
  it('a non-finite accuracy is neutral, never NaN', () => {
    expect(getTrackRecordMultiplier(NaN)).toBe(1.0);
  });
});

describe('getValuationMultiplier', () => {
  it('thresholds from both sides', () => {
    expect(getValuationMultiplier(40)).toBe(1.15);
    expect(getValuationMultiplier(40 - EPS)).toBe(1.08);
    expect(getValuationMultiplier(15)).toBe(1.08);
    expect(getValuationMultiplier(15 - EPS)).toBe(1.0);
    expect(getValuationMultiplier(-25)).toBe(0.9);
    expect(getValuationMultiplier(-25 + EPS)).toBe(1.0);
  });
  it('unknown and non-finite are neutral', () => {
    expect(getValuationMultiplier(undefined)).toBe(1.0);
    expect(getValuationMultiplier(NaN)).toBe(1.0);
    expect(getValuationMultiplier(Infinity)).toBe(1.0);
    expect(getValuationMultiplier(-Infinity)).toBe(1.0);
  });
  it('is monotone non-decreasing in upside', () => {
    let last = 0;
    for (let u = -100; u <= 100; u += 1) {
      const m = getValuationMultiplier(u);
      expect(m).toBeGreaterThanOrEqual(last - 1e-12);
      last = m;
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Freshness
// ──────────────────────────────────────────────────────────────────────────

describe('getFreshnessMultiplier', () => {
  it('under a day is full strength', () => {
    expect(getFreshnessMultiplier(0)).toBe(1.0);
    expect(getFreshnessMultiplier(1 - EPS)).toBe(1.0);
  });
  it('decays with a ~6-day half-life', () => {
    expect(getFreshnessMultiplier(1)).toBeCloseTo(Math.exp(-0.115), 10);
    expect(getFreshnessMultiplier(2)).toBeCloseTo(0.7945, 4);
    expect(getFreshnessMultiplier(5)).toBeCloseTo(0.5627, 4);
    expect(getFreshnessMultiplier(10)).toBeCloseTo(0.3166, 4);
    // half-life: ln2 / 0.115 = 6.027 days
    expect(getFreshnessMultiplier(Math.log(2) / 0.115)).toBeCloseTo(0.5, 6);
  });
  it('reaches the floor at ln(1/0.15)/0.115 ≈ 16.5 days and stays there', () => {
    const tFloor = Math.log(1 / 0.15) / 0.115;
    expect(getFreshnessMultiplier(tFloor - 0.01)).toBeGreaterThan(0.15);
    expect(getFreshnessMultiplier(tFloor)).toBeCloseTo(0.15, 10);
    expect(getFreshnessMultiplier(1000)).toBe(0.15);
  });
  it('unknown age is treated as maximally stale, not as fresh', () => {
    expect(getFreshnessMultiplier(null)).toBe(0.15);
  });
  it('a FUTURE-dated trade is not fresh (regression: it scored ×1.0)', () => {
    expect(getFreshnessMultiplier(-1)).toBe(0.15);
    expect(getFreshnessMultiplier(-400)).toBe(0.15);
  });
  it('a non-finite age is treated as unknown', () => {
    expect(getFreshnessMultiplier(NaN)).toBe(0.15);
  });
  it('honours custom rate and floor (the shadow-scoring knobs)', () => {
    expect(getFreshnessMultiplier(60, 0.115, 0.3)).toBeCloseTo(0.3, 10);
    expect(getFreshnessMultiplier(1, 0.5)).toBeCloseTo(Math.exp(-0.5), 10);
  });
  it('is monotone non-increasing in age', () => {
    let last = Infinity;
    for (let a = 0; a <= 40; a += 0.25) {
      const m = getFreshnessMultiplier(a);
      expect(m).toBeLessThanOrEqual(last + 1e-12);
      last = m;
    }
  });
});

describe('getFreshnessLevel agrees with the multiplier', () => {
  it('classifies the documented bands', () => {
    expect(getFreshnessLevel(0)).toBe('fresh');
    expect(getFreshnessLevel(1 - EPS)).toBe('fresh');
    expect(getFreshnessLevel(1)).toBe('recent');
    expect(getFreshnessLevel(3)).toBe('recent');
    expect(getFreshnessLevel(3 + EPS)).toBe('aging');
    expect(getFreshnessLevel(7)).toBe('aging');
    expect(getFreshnessLevel(7 + EPS)).toBe('stale');
  });
  it('unknown / future / non-finite all read stale, like the multiplier', () => {
    expect(getFreshnessLevel(null)).toBe('stale');
    expect(getFreshnessLevel(-5)).toBe('stale');
    expect(getFreshnessLevel(NaN)).toBe('stale');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Track-record shrinkage + tiers
// ──────────────────────────────────────────────────────────────────────────

describe('shrunkAccuracy', () => {
  it('an empty record is a coin flip', () => expect(shrunkAccuracy(0, 0)).toBe(0.5));
  it('matches the documented examples', () => {
    expect(shrunkAccuracy(1, 1)).toBeCloseTo(0.625, 10);
    expect(shrunkAccuracy(5, 5)).toBeCloseTo(0.8125, 10);
    expect(shrunkAccuracy(8, 10)).toBeCloseTo(0.73077, 5);
    expect(shrunkAccuracy(30, 40)).toBeCloseTo(0.73256, 5);
  });
  it('shrinks toward 0.5, never beyond the raw rate', () => {
    for (const [w, n] of [[1, 1], [5, 5], [9, 10], [0, 5], [0, 20]] as [number, number][]) {
      const raw = w / n;
      const shrunk = shrunkAccuracy(w, n);
      expect(Math.abs(shrunk - 0.5)).toBeLessThan(Math.abs(raw - 0.5) + 1e-12);
    }
  });
  it('converges to the raw rate as n grows', () => {
    expect(shrunkAccuracy(7500, 10000)).toBeCloseTo(0.75, 3);
  });
  it('a negative or zero total falls back to 0.5', () => {
    expect(shrunkAccuracy(3, 0)).toBe(0.5);
    expect(shrunkAccuracy(3, -1)).toBe(0.5);
  });
});

describe('getConvictionLevel', () => {
  it('uses the shared thresholds, from both sides', () => {
    expect(getConvictionLevel(CONVICTION_THRESHOLDS.high)).toBe('HIGH');
    expect(getConvictionLevel(CONVICTION_THRESHOLDS.high - EPS)).toBe('WATCH');
    expect(getConvictionLevel(CONVICTION_THRESHOLDS.watch)).toBe('WATCH');
    expect(getConvictionLevel(CONVICTION_THRESHOLDS.watch - EPS)).toBe('LOW');
    expect(getConvictionLevel(0)).toBe('LOW');
  });
});

describe('normalization constants', () => {
  it('the saturation anchor maps raw 420 to exactly 80', () => {
    expect(SCORE_HALF_SATURATION).toBe(105);
    expect((100 * 420) / (420 + SCORE_HALF_SATURATION)).toBeCloseTo(80, 10);
  });
  it('MAX_POSSIBLE_RAW is the product it claims to be', () => {
    const insider = 10 * 20 * 1.0 * 3.0 * MAX_INSIDER_TIMING_MULT * 1.15;
    const options = MAX_OPTIONS_SCORE_TOTAL * 2.0;
    expect(MAX_POSSIBLE_RAW).toBeCloseTo((insider + options) * 1.2 * 1.15, 6);
    expect(MAX_POSSIBLE_RAW).toBeCloseTo(2855.04, 2);
  });
});
