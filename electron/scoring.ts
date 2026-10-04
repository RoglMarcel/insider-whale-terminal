import { upgradeFairValue } from '../src/lib/fairValueDisplay';
import type {
  RawInsiderTrade,
  OptionsActivity,
  DormantFactor,
  ScoreBreakdown,
  ConvictionLevel,
  TickerAggregate,
  PoliticianTrade,
  PoliticianComboTier,
} from '../src/types';
import {
  CONVICTION_THRESHOLDS,
  COMBO_SOFT_MULT,
  POLITICIAN_INSIDER_SOFT_MULT,
  POLITICIAN_OPTIONS_SOFT_MULT,
  MEGA_SOFT_MULT,
  CORROBORATION_GATE,
  LEGACY_POLITICIAN_COMBO_BONUS,
  classifyTransaction,
  getFreshnessMultiplier,
  isLateFiling,
  daysBetween,
  normalizeInsiderName,
  MAX_INSIDER_TIMING_MULT,
  MAX_OPTION_BASE_POINTS,
  MAX_OPTIONS_SCORE_TOTAL,
  DEFAULT_SCORING_CONFIG,
  type ScoringConfig,
} from '../src/types';
import { admissibleTrade } from '../src/lib/tradeEligibility';
import { eventDate, utcInstantMs, utcDateMs } from '../src/lib/utcDate';
import { MAX_SANE_TRADE_VALUE, MAX_SANE_SHARE_PRICE, sanitizeTradeAmounts } from './scraper/util';

// ──────────────────────────────────────────────────────────────────────────
// Theoretical maxima — used to normalize the composite raw score to 0–100.
// ──────────────────────────────────────────────────────────────────────────

const MAX_RANK_WEIGHT = 10;
const MAX_DOLLAR_VOLUME_POINTS = 20;
const MAX_TYPE_MODIFIER = 1.0;
const MAX_CLUSTER_MULTIPLIER = 3.0;
const MAX_INSIDER_TIMING = MAX_INSIDER_TIMING_MULT; // 2.34 — shared with the breakdown UI
const MAX_OPTIONS_TIMING = 2.0;
// Read from the config rather than hard-coded: `getVixMultiplier` takes its cap
// from the active ScoringConfig, so a shadow config with a different vixCap used
// to make MAX_POSSIBLE_RAW quietly wrong.
const MAX_VIX_MULTIPLIER = DEFAULT_SCORING_CONFIG.vixCap;
const MAX_TRACK_RECORD = 1.2;
const MAX_VALUATION = 1.15; // Feature 10 — deep-undervaluation boost ceiling
const MAX_OPTIONS_SCORE = MAX_OPTIONS_SCORE_TOTAL; // 227.136 — shared with the breakdown UI

const MAX_INSIDER_RAW =
  MAX_RANK_WEIGHT *
  MAX_DOLLAR_VOLUME_POINTS *
  MAX_TYPE_MODIFIER *
  MAX_CLUSTER_MULTIPLIER *
  MAX_INSIDER_TIMING *
  MAX_VIX_MULTIPLIER;

const MAX_OPTIONS_RAW = MAX_OPTIONS_SCORE * MAX_OPTIONS_TIMING;

/**
 * ≈ 2855.04 — the theoretical ceiling (every factor at its maximum at once):
 *   MAX_INSIDER_RAW  = 10 · 20 · 1.0 · 3.0 · 2.34 · 1.15 = 1614.60
 *   MAX_OPTIONS_RAW  = 227.136 · 2.0                     =  454.272
 *   (1614.60 + 454.272) · 1.2 · 1.15                     = 2855.043
 * (The comment said 2662.15 for a while — that is the value from before the
 * premium ladder gained rungs above $2M and its top base rose 18 → 26.)
 * Retained only as a reference for the score-breakdown display; it is NO LONGER
 * the score denominator. Those maxima essentially never co-occur, so dividing by
 * them crushed real signals into single digits and let the flat combo bonus
 * decide the conviction tier on its own.
 */
export const MAX_POSSIBLE_RAW =
  (MAX_INSIDER_RAW + MAX_OPTIONS_RAW) * MAX_TRACK_RECORD * MAX_VALUATION; // freshness max = 1.0

/**
 * Conviction is mapped from the composite raw score through a saturating curve:
 *
 *     score = 100 × raw / (raw + SCORE_HALF_SATURATION)
 *
 * It is monotonic, smooth, and asymptotes toward 100 (no hard clipping), so
 * strong signals spread across the range instead of all pinning at the ceiling.
 * The half-saturation point is anchored to a genuinely strong-but-plausible
 * signal — a top-exec buy in a ~3-insider cluster heading into earnings, ≈ 420
 * raw — which should read at the HIGH threshold (80). For score = 100·r/(r+K),
 * mapping r → 80 gives K = r / 4. With this curve a clean single CEO buy lands in
 * the WATCH band and the +30 combo bonus becomes a boost on a meaningful base
 * rather than the only path into a tier.
 */
const STRONG_SIGNAL_RAW = 420;
export const SCORE_HALF_SATURATION = STRONG_SIGNAL_RAW / 4; // ≈ 105

/** Feature 4 — legacy flat bonus (kept for shadow/legacy score comparison only). */
export const COMBO_BONUS = 30;

/**
 * Live corroboration model (v1.0.46+): soft multipliers replace flat +20…+45
 * so a combo alone cannot jump two conviction tiers. Applied only when the
 * pre-corroboration base score is already ≥ WATCH (gate).
 *
 * DEFINED IN `src/types` and re-exported here: the breakdown UI renders these
 * numbers, and a second copy on the renderer side had already drifted into
 * showing the legacy flat bonuses for a model that no longer uses them.
 */
export {
  COMBO_SOFT_MULT,
  POLITICIAN_INSIDER_SOFT_MULT,
  POLITICIAN_OPTIONS_SOFT_MULT,
  MEGA_SOFT_MULT,
  CORROBORATION_GATE,
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  // NaN must not survive a clamp. `Math.max(0, NaN)` is NaN and `Math.min(100,
  // NaN)` is NaN, so the plain form let a single NaN input (a NaN vix reading,
  // a NaN cached accuracy) propagate all the way to `finalScore` — where
  // `getConvictionLevel(NaN)` then silently returned 'LOW' and the value was
  // written to SQLite. Every factor below is also guarded at its source; this is
  // the backstop that makes the invariant total.
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** A multiplier that is not a finite number is no information — fall back to neutral. */
function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Broad "is this an open-market acquisition (not a sale)" check. SEC code `A`
 * (grant/award) is intentionally NOT treated as a buy so this agrees with
 * classifyTransaction, which excludes awards from scoring.
 */
export function isBuyTrade(t: RawInsiderTrade): boolean {
  const tt = (t.transactionType ?? '').toString().toUpperCase().trim();
  if (tt.startsWith('S') || tt.includes('SALE') || tt.includes('SELL')) return false;
  return tt.startsWith('P') || tt.includes('BUY') || tt.includes('PURCHASE');
}

/** A trade contributes to the score only if its type modifier is > 0 (Feature 2). */
export function isScoringEligible(t: RawInsiderTrade, asOf = Date.now()): boolean {
  return classifyTransaction(t.transactionType).modifier > 0 &&
    admissibleTrade(t, undefined, asOf);
}

// ──────────────────────────────────────────────────────────────────────────
// Step 1 — Insider rank weight
// ──────────────────────────────────────────────────────────────────────────

// BACKTEST 2026-07-03: left unchanged — IC halved out-of-sample (0.161 → 0.073,
// n=88, Q4−Q1 p=0.171). Q4 beat Q1 at every horizon but significance existed
// only at 5d (p=0.015; 20d p=0.675): a short-horizon hint, not a proven
// structural edge. Positive OOS sign → no downweight either. Revisit with more
// history.
export function getRankWeight(roleRaw: string): { weight: number; category: string } {
  const role = (roleRaw ?? '').toLowerCase();
  const has = (...terms: string[]) => terms.some((t) => role.includes(t));
  const hasWord = (...ws: string[]) => ws.some((w) => new RegExp(`\\b${w}\\b`).test(role));
  const isVice = hasWord('vp', 'svp', 'evp', 'avp') || has('vice president', 'vice-president');

  if (has('chief executive') || hasWord('ceo') || (has('exec') && has('chair'))) {
    return { weight: 10, category: 'exec' };
  }
  if (has('chief financial', 'chief operating') || hasWord('cfo', 'coo')) {
    return { weight: 8, category: 'cfo' };
  }
  // OpenInsider abbreviates titles ("Pres", "Dir", "COB", "GC") — match those too.
  if ((has('president') || hasWord('pres')) && !isVice) {
    return { weight: 8, category: 'cfo' };
  }
  // Founders/co-founders carry outsized conviction even without a C-suite title.
  if (has('founder')) {
    return { weight: 8, category: 'cfo' };
  }
  if (
    has('chief technology', 'chief marketing', 'chief accounting', 'chairman') ||
    hasWord('cto', 'cmo', 'cio', 'chro', 'cob') ||
    role.includes('chief')
  ) {
    return { weight: 6, category: 'csuite' };
  }
  // 10% owners / major beneficial holders are significant reporting persons, not
  // "other" — a large holder adding to an already-big stake is a real signal.
  // Checked before directors so "Dir, 10%" takes the higher weight.
  if (has('10%', 'beneficial owner', 'major shareholder')) {
    return { weight: 5, category: 'director' };
  }
  if (has('director', 'board') || hasWord('dir')) {
    return { weight: 4, category: 'director' };
  }
  if (isVice || hasWord('gc') || has('officer', 'senior', 'head of', 'general counsel', 'secretary', 'treasurer')) {
    return { weight: 3, category: 'vp' };
  }
  // A role we cannot parse is UNKNOWN, not junior.
  //
  // This used to return weight 1 — the floor — so a missing or unrecognised
  // title scored like the least important insider in the company. Nothing
  // supports that: an unparsed title is a scraping gap, not a demotion, and it
  // hits 4.5% of the 8,343 stored signals that have an insider leg.
  //
  // 4 is the MODE of the rank weights over the 7,967 rows whose role IS
  // recognised (42.9% at weight 4; median 5, mean 6.08). The mode is the
  // conservative choice of the three: it assumes the most common insider we
  // actually see — a director — and it never lets an unknown title outrank a
  // known one. Measured over thousands of rows, not fitted to any trade outcome.
  return { weight: UNKNOWN_ROLE_WEIGHT, category: 'unknown' };
}

/** See the note in `getRankWeight` — the modal recognised rank, not the floor. */
export const UNKNOWN_ROLE_WEIGHT = 4;

/**
 * Does this role earn the pre-earnings FINANCE bonus on top of its rank weight?
 *
 * A CFO already carries rank weight 8 against a director's 4, so paying the
 * ×1.3 finance bonus as well counted one fact — "this person sees the numbers
 * before anyone else" — twice in the same multiplicative chain
 * (`docs/audit/FACTORS.md` §1). The rank keeps that information; the bonus is
 * withdrawn where the rank already encodes it, and kept where it does not: a
 * Controller, a Treasurer or a VP Finance is ranked 3–4 like any other officer,
 * and for them "finance insider, days before earnings" is genuinely new.
 */
export function earnsFinanceTimingBonus(role: string): boolean {
  return isFinanceInsider(role) && getRankWeight(role).category !== 'cfo';
}

export function isFinanceInsider(role: string): boolean {
  const r = (role ?? '').toLowerCase();
  return (
    r.includes('cfo') ||
    r.includes('chief financial') ||
    r.includes('financ') ||
    r.includes('audit') ||
    r.includes('treasurer') ||
    r.includes('controller') ||
    r.includes('accounting')
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Step 2 — Dollar volume points
// ──────────────────────────────────────────────────────────────────────────

/**
 * Points for the magnitude of a buy. When market cap is known, the buy is scored
 * RELATIVE to company size (a $5M buy is enormous for a $200M company and noise
 * for a $2T one); otherwise it falls back to absolute dollar buckets. Callers pass
 * the per-insider average rather than the cluster total so this stays decorrelated
 * from the separate cluster-count multiplier.
 *
 * BACKTEST 2026-07-03: left unchanged — classic overfit signature in the
 * absolute-bucket fallback path (IC(is)=0.272 → IC(oos)=−0.011, n=88), but the
 * Q4−Q1 spread was not significant in either direction (p=0.090) and only 27
 * out-of-sample observations exist (SE ≈ 0.20 — cannot distinguish zero from a
 * modest real effect). Note the test measured the ABSOLUTE buckets below, not
 * the market-cap-relative branch production now uses. Retest before touching.
 */
export function getDollarVolumePoints(buyValue: number, marketCap?: number): number {
  if (!Number.isFinite(buyValue)) return 1;
  if (marketCap != null && Number.isFinite(marketCap) && marketCap > 0) {
    const ratio = buyValue / marketCap;
    if (ratio >= 0.005) return 20; // ≥ 0.5% of market cap
    if (ratio >= 0.001) return 14; // ≥ 0.1%
    if (ratio >= 0.0002) return 10; // ≥ 0.02%
    if (ratio >= 0.00005) return 5; // ≥ 0.005%
    return 1;
  }
  // NOTE the `>=` on the top rung. It used to be `>`, while every rung below it
  // used `>=`: a buy of exactly $5,000,000 fell through to 14 points and
  // $5,000,001 scored 20 — a 43% jump across one cent, from an inconsistency
  // rather than a decision. 20 trades in the live history sit exactly on this
  // threshold. The cap-relative branch above was always consistent.
  if (buyValue >= 5_000_000) return 20;
  if (buyValue >= 1_000_000) return 14;
  if (buyValue >= 500_000) return 10;
  if (buyValue >= 100_000) return 5;
  return 1;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 3 — Cluster bonus multiplier (distinct insiders, last 30 days)
// ──────────────────────────────────────────────────────────────────────────

export function getClusterMultiplier(distinctInsiders: number): number {
  if (!Number.isFinite(distinctInsiders)) return 1.0;
  if (distinctInsiders >= 4) return 3.0;
  if (distinctInsiders === 3) return 2.0;
  if (distinctInsiders === 2) return 1.5;
  return 1.0;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 4 — Earnings timing (Feature 5)
// ──────────────────────────────────────────────────────────────────────────

export function getInsiderTimingMultiplier(
  daysToEarnings: number | undefined,
  hasFinanceInsiderBuying: boolean,
): { multiplier: number; notes: string[] } {
  const notes: string[] = [];
  let multiplier = 1.0;
  if (daysToEarnings != null && Number.isFinite(daysToEarnings) && daysToEarnings >= 0) {
    if (daysToEarnings <= 5) {
      multiplier = 1.8;
      notes.push('Earnings in 0–5 days (insider ×1.8)');
    } else if (daysToEarnings <= 15) {
      multiplier = 1.5;
      notes.push('Earnings in 6–15 days (insider ×1.5)');
    } else if (daysToEarnings <= 30) {
      multiplier = 1.3;
      notes.push('Earnings in 16–30 days (insider ×1.3)');
    }
    if (hasFinanceInsiderBuying && daysToEarnings <= 15) {
      multiplier *= 1.3;
      notes.push('Finance insider buying 1–15 days pre-earnings (×1.3)');
    }
  }
  return { multiplier, notes };
}

export function getOptionsTimingMultiplier(daysToEarnings: number | undefined): number {
  if (daysToEarnings == null || !Number.isFinite(daysToEarnings) || daysToEarnings < 0) return 1.0;
  if (daysToEarnings <= 5) return 2.0;
  if (daysToEarnings <= 15) return 1.6;
  if (daysToEarnings <= 30) return 1.3;
  return 1.0;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 5 — Detailed options scoring (Feature 3)
// ──────────────────────────────────────────────────────────────────────────

function optionPremium(o: OptionsActivity): number {
  const p = o.premiumTotal ?? o.notional ?? 0;
  return Number.isFinite(p) ? p : 0;
}

/**
 * Premium ladder. The top rung used to be a flat 18 for anything above $2M, which
 * made a $12.5M print score exactly like a $7.4M one — on mega-caps (where
 * eight-figure prints are routine) that erased the size advantage and could flip a
 * clearly bull-dominated tape to "net bearish" (observed live on NVDA: $14.3M calls
 * vs $11.8M puts scored −3). The ladder now keeps resolving above $2M; everything
 * below $2M is unchanged.
 */
function baseOptionPoints(premium: number): number {
  if (!Number.isFinite(premium) || premium <= 0) return 0;
  // All rungs use `>=`. The top three used `>` while the bottom two used `>=`,
  // so a print of exactly $2,000,000 scored 14 and $2,000,001 scored 18 — an
  // inconsistency, not a decision. (No live print sits exactly on a threshold,
  // so this changes nothing in the current history; it makes the ladder honest.)
  if (premium >= 10_000_000) return MAX_OPTION_BASE_POINTS; // 26
  if (premium >= 5_000_000) return 22;
  if (premium >= 2_000_000) return 18;
  if (premium >= 1_000_000) return 14;
  if (premium >= 500_000) return 9;
  return 3;
}

/** Points for one option entry (always positive magnitude). */
export function optionTiming(o: OptionsActivity, asOf = Date.now()): { eligible: boolean; dte?: number; age: number | null } {
  const observed = utcInstantMs(o.scrapedAt);
  const event = utcInstantMs(o.eventAt);
  if ((o.scrapedAt && observed === null) || (o.eventAt && event === null) ||
      (observed !== null && observed > asOf) || (event !== null && event > asOf))
    return { eligible: false, age: null };
  if (!o.expiry && o.dte !== undefined && o.dte < 0) return { eligible: false, age: null };
  const expiry = o.expiry ? utcDateMs(o.expiry) : null;
  const today = Math.floor(asOf / 86_400_000) * 86_400_000;
  if (o.expiry && (expiry === null || expiry < today)) return { eligible: false, age: null };
  const clock = event ?? observed;
  // An unanchored cached DTE cannot safely earn a timing bonus.
  const dte = expiry !== null ? (expiry - today) / 86_400_000 :
    o.dte !== undefined && clock !== null ? o.dte - Math.floor((asOf - clock) / 86_400_000) : undefined;
  return { eligible: dte === undefined || dte >= 0, dte, age: clock === null ? null : (asOf - clock) / 86_400_000 };
}

export function scoreOneOption(o: OptionsActivity, asOf = Date.now()): number {
  const timing = optionTiming(o, asOf);
  if (!timing.eligible) return 0;
  const dte = timing.dte;
  let pts = baseOptionPoints(optionPremium(o));
  if (o.isSweep) pts *= 1.6;
  // Guard against expired contracts (negative DTE can leak in via the 72h temporal
  // merge) so they don't collect the short-dated "near-term gamma" boost.
  if (dte != null && Number.isFinite(dte) && dte >= 0) {
    if (dte < 21) pts *= 1.5;
    else if (dte <= 60) pts *= 1.2;
    else if (dte > 180) pts *= 0.8;
  }
  // Signed: positive = out-of-the-money. Only OTM strikes signal speculative
  // conviction; a deep-ITM print is a conservative stock substitute, not a bet.
  if (o.otmPercent != null && Number.isFinite(o.otmPercent)) {
    if (o.otmPercent > 15) pts *= 1.4;
    else if (o.otmPercent >= 5) pts *= 1.1;
  }
  if (o.volOiRatio != null && Number.isFinite(o.volOiRatio)) {
    if (o.volOiRatio > 10) pts *= 1.3;
    else if (o.volOiRatio >= 3) pts *= 1.1;
  }
  return finiteOr(pts, 0);
}

/**
 * Net options score. Per direction, prints sum with geometric decay
 * (best + ½·2nd + ¼·3rd + …, bounded at 2× the best) so repeated whale flow —
 * the persistence the 72h merge exists to capture — counts beyond the first
 * print without letting many small prints swamp one huge one.
 */
export function scoreOptionsDetailed(options: readonly OptionsActivity[], asOf = Date.now()): { score: number; notes: string[] } {
  const notes: string[] = [];
  const bulls: number[] = [];
  const bears: number[] = []; // stored as positive magnitudes
  for (const o of options) {
    const pts = scoreOneOption(o, asOf);
    // Direction comes from the scraper-normalized sentiment (already accounts for
    // sold puts = bullish, sold calls = bearish), so treat bull/bear symmetrically.
    if (o.sentiment === 'bearish') bears.push(pts);
    else if (o.sentiment === 'bullish') bulls.push(pts);
  }
  const decayedSum = (xs: number[]) =>
    xs.sort((a, b) => b - a).reduce((s, x, i) => s + x * Math.pow(0.5, i), 0);
  const bullScore = decayedSum(bulls);
  const bearScore = decayedSum(bears);
  if (bullScore > 0) notes.push(`Bullish options flow (+${bullScore.toFixed(0)} pts)`);
  if (bearScore > 0) notes.push(`Bearish put flow (−${bearScore.toFixed(0)} pts)`);
  return { score: bullScore - bearScore, notes };
}

// ──────────────────────────────────────────────────────────────────────────
// Context multipliers (Features 6 + 8)
// ──────────────────────────────────────────────────────────────────────────

export function getVixMultiplier(vix: number | undefined, cap = DEFAULT_SCORING_CONFIG.vixCap): number {
  // A NaN reading used to produce a NaN multiplier (`NaN <= 20` and `NaN >= 35`
  // are both false, so the linear branch ran on NaN) and from there a NaN score.
  if (vix == null || !Number.isFinite(vix) || !Number.isFinite(cap)) return 1.0;
  // Smooth ramp instead of a cliff: VIX 20→35 maps linearly to 1.0→cap, so a
  // reading of 24.9 vs 25.1 no longer flips the whole insider score by 15%.
  if (vix <= 20) return 1.0;
  if (vix >= 35) return cap;
  return 1.0 + (cap - 1.0) * ((vix - 20) / 15);
}

export function getTrackRecordMultiplier(
  bestAccuracy3m: number | undefined,
  slope = DEFAULT_SCORING_CONFIG.trackRecordSlope,
): number {
  // `clamp(NaN, …)` used to be NaN (Math.min(1.2, NaN) === NaN), so a NaN
  // accuracy propagated into the score. Guard at the source as well as in clamp.
  if (bestAccuracy3m == null || !Number.isFinite(bestAccuracy3m) || !Number.isFinite(slope)) return 1.0;
  // Smooth curve instead of two step thresholds: with Bayesian shrinkage the
  // old >0.7 boost effectively required a perfect 5-for-5 record, leaving the
  // multiplier at exactly 1.0 for nearly everyone the app pays to track.
  // 0.5 (coin-flip) → 1.0; 0.8 → ~1.20; 0.3 → 0.87. Clamped to [0.85, 1.2].
  return clamp(1 + (bestAccuracy3m - 0.5) * slope, 0.85, 1.2);
}

/**
 * Feature 10 — fold fair-value upside into conviction: an insider buying a name
 * independent models call deeply undervalued is a stronger signal; an overvalued
 * one is tempered. `upsidePct` is (fairValue − price)/price × 100.
 *
 * Legacy multiplier for historical/research inputs. Live scraping supplies a
 * structured fairValue snapshot with safety margin and confidence weighting.
 */
export function getValuationMultiplier(upsidePct: number | undefined): number {
  if (upsidePct == null || !Number.isFinite(upsidePct)) return 1.0;
  if (upsidePct >= 40) return 1.15;
  if (upsidePct >= 15) return 1.08;
  if (upsidePct <= -25) return 0.9;
  return 1.0;
}

// ──────────────────────────────────────────────────────────────────────────
// Composite scoring
// ──────────────────────────────────────────────────────────────────────────

export function getConvictionLevel(score: number): ConvictionLevel {
  if (score >= CONVICTION_THRESHOLDS.high) return 'HIGH';
  if (score >= CONVICTION_THRESHOLDS.watch) return 'WATCH';
  return 'LOW';
}

export interface ScoredTicker {
  ticker: string;
  companyName?: string;
  score: number;
  convictionLevel: ConvictionLevel;
  totalDollarVolume: number;
  insiderCount: number;
  topInsiderRole: string | null;
  topInsiderName: string | null;
  breakdown: ScoreBreakdown;
  // Feature 1
  tradeDate: string | null;
  filingDate: string | null;
  lateFiling: boolean;
  signalAgeDays: number | null;
  // Feature 4
  comboSignal: boolean;
  // Congressional leg
  politicianScore: number;
  politicianComboTier: PoliticianComboTier | null;
  /** Pre-v1.0.46 flat-bonus score — always computed for shadow comparison. */
  legacyScore?: number;
}

/** Feature 4 — combo when a recent scoring-eligible insider buy + big bullish options coincide. */
export function detectCombo(trades: RawInsiderTrade[], options: OptionsActivity[], asOf = Date.now()): boolean {
  const insiderHit = trades.some((t) => {
    if (!isScoringEligible(t, asOf)) return false;
    const age = daysBetween(t.tradeDate, asOf);
    // Missing/invalid trade dates must NOT count as "fresh".
    return age != null && age >= 0 && age <= 14;
  });
  if (!insiderHit) return false;
  // Options are scraped live (and only merged forward up to 72h), so any present
  // print is already "current" — a single big BULLISH one confirms the options
  // leg. Bearish flow contradicts the insider buy and must not mint a combo.
  const optionsHit = options.some((o) => o.sentiment === 'bullish' && optionTiming(o, asOf).eligible && optionPremium(o) > 250_000);
  return insiderHit && optionsHit;
}

// ──────────────────────────────────────────────────────────────────────────
// Congressional (politician) trading leg
// ──────────────────────────────────────────────────────────────────────────

/** Bonus a politician-combo tier adds after normalization (LEGACY/shadow only). */
export const POLITICIAN_COMBO_BONUS = LEGACY_POLITICIAN_COMBO_BONUS;

/** Base points from a disclosed amount midpoint. */
function politicianAmountPoints(midpoint: number): number {
  if (midpoint > 500_000) return 20;
  if (midpoint > 250_000) return 15;
  if (midpoint > 100_000) return 10;
  if (midpoint > 50_000) return 6;
  if (midpoint > 15_000) return 3;
  return 1;
}

/** Committee-relevance multiplier — some committees confer more information edge. */
function committeeMultiplier(committee: string | undefined): number {
  const c = (committee ?? '').toLowerCase();
  if (!c) return 1.0;
  if (c.includes('financ') || c.includes('banking')) return 1.5;
  if (c.includes('armed') || c.includes('defense')) return 1.4;
  if (c.includes('technology') || c.includes('commerce') || c.includes('science')) return 1.3;
  if (c.includes('energy') || c.includes('environment')) return 1.2;
  return 1.0;
}

function fmtUSDShort(v: number): string {
  return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1_000)}k`;
}

export type PoliticianScoreMode = 'live' | 'legacy';

/**
 * Score the congressional leg for one ticker.
 *
 * `legacy` — original additive points (all buys count; late disclose ×0.8).
 * `live` — score-moving only when clustered (≥2 politicians in 30d) OR aligned
 *   with a recent insider buy; lone low-dollar prints are notes/badge only.
 *   Late disclosure (>30d) is penalized ×0.5 (stricter than legacy ×0.8).
 */
export function getPoliticianScore(
  trades: PoliticianTrade[],
  opts?: { mode?: PoliticianScoreMode; insiderTrades?: RawInsiderTrade[]; asOf?: number },
): { score: number; notes: string[] } {
  const asOf = opts?.asOf ?? Date.now();
  const mode = opts?.mode ?? 'live';
  trades = trades.filter(t => eventDate(t.tradeDate, asOf).state === 'valid' && eventDate(t.disclosureDate, asOf).state === 'valid' && (!t.scrapedAt || (utcInstantMs(t.scrapedAt) ?? Infinity) <= asOf));
  const notes: string[] = [];
  if (!trades.length) return { score: 0, notes };

  // Cluster: distinct politicians BUYING this ticker within 30 days.
  const recentBuyers = new Set<string>();
  for (const t of trades) {
    if (t.transactionType !== 'buy') continue;
    const age = daysBetween(t.tradeDate, asOf);
    if (age != null && age >= 0 && age <= 30) recentBuyers.add(normalizeInsiderName(t.politician) || t.politician.toLowerCase());
  }
  const clusterMult = recentBuyers.size >= 3 ? 2.5 : recentBuyers.size === 2 ? 1.8 : 1.0;

  const hasInsiderAlignment = (opts?.insiderTrades ?? []).some((t) => {
    if (!isScoringEligible(t, asOf)) return false;
    const age = daysBetween(t.tradeDate, asOf);
    return age != null && age >= 0 && age <= 14;
  });

  // Live mode: lone politician activity does not move the score (badge/notes only).
  const scoreEligible =
    mode === 'legacy' || recentBuyers.size >= 2 || (recentBuyers.size >= 1 && hasInsiderAlignment);

  let total = 0;
  let sellCount = 0;
  const buys: { name: string; amt: number }[] = [];
  for (const t of trades) {
    const base = politicianAmountPoints(t.amountMidpoint);
    const committee = committeeMultiplier(t.committee);
    const fresh = getFreshnessMultiplier(daysBetween(t.tradeDate, asOf));
    let s = base * committee * fresh;
    if (t.transactionType === 'sell') {
      s = s * -0.5; // contra-signal — not amplified by the buy cluster
      sellCount++;
    } else {
      s = s * clusterMult;
      buys.push({ name: t.politician, amt: t.amountMidpoint });
    }
    // Late disclosure: legacy ×0.8; live ×0.5 (less actionable).
    if (t.daysToDisclose != null && t.daysToDisclose > 30) s = s * (mode === 'live' ? 0.5 : 0.8);
    total += s;
  }

  const score = scoreEligible ? Math.max(0, total) : 0;

  if (buys.length) {
    const top = [...buys].sort((a, b) => b.amt - a.amt).slice(0, 3);
    notes.push(`🏛️ ${buys.length} congressional buy(s): ${top.map((b) => `${b.name} (${fmtUSDShort(b.amt)})`).join(', ')}`);
  }
  if (recentBuyers.size >= 2) {
    notes.push(`🏛️ ${recentBuyers.size} members of Congress buying (cluster ×${clusterMult})`);
  } else if (mode === 'live' && buys.length && !scoreEligible) {
    notes.push('🏛️ Lone politician print — badge only (needs cluster or insider alignment to affect score)');
  }
  if (sellCount > 0 && total <= 0) {
    notes.push(`⚠ ${sellCount} congressional sell(s) — contra-signal outweighs buys here`);
  } else if (sellCount > 0) {
    notes.push(`⚠ ${sellCount} congressional sell(s) also on file`);
  }
  return { score, notes };
}

/** Soft corroboration multiplier for live scoring (1.0 = none). */
export function corroborationSoftMult(
  classicCombo: boolean,
  politicianComboTier: PoliticianComboTier | null,
): number {
  if (politicianComboTier === 'MEGA_SIGNAL') return MEGA_SOFT_MULT;
  if (politicianComboTier === 'POLITICIAN_INSIDER') {
    return classicCombo ? Math.max(COMBO_SOFT_MULT, POLITICIAN_INSIDER_SOFT_MULT) : POLITICIAN_INSIDER_SOFT_MULT;
  }
  if (politicianComboTier === 'POLITICIAN_OPTIONS') {
    return classicCombo ? Math.max(COMBO_SOFT_MULT, POLITICIAN_OPTIONS_SOFT_MULT) : POLITICIAN_OPTIONS_SOFT_MULT;
  }
  if (classicCombo) return COMBO_SOFT_MULT;
  return 1.0;
}

/**
 * Politician combo tier — congressional buying aligned with insider buying
 * and/or bullish options. Priority (no double-count): all three → MEGA_SIGNAL;
 * politician+insider → POLITICIAN_INSIDER; politician+options → POLITICIAN_OPTIONS.
 */
export function detectPoliticianCombo(
  politicianTrades: PoliticianTrade[],
  insiderTrades: RawInsiderTrade[],
  options: OptionsActivity[],
  asOf = Date.now(),
): PoliticianComboTier | null {
  const hasPoliticianBuy = politicianTrades.some((t) => {
    if (t.transactionType !== 'buy' || eventDate(t.disclosureDate, asOf).state !== 'valid' || (t.scrapedAt && (utcInstantMs(t.scrapedAt) ?? Infinity) > asOf)) return false;
    const age = daysBetween(t.tradeDate, asOf);
    return age != null && age >= 0 && age <= 30;
  });
  if (!hasPoliticianBuy) return null;

  // Same insider eligibility as detectCombo (modifier > 0 + known age ≤14).
  const hasInsiderBuy = insiderTrades.some((t) => {
    if (!isScoringEligible(t, asOf)) return false;
    const age = daysBetween(t.tradeDate, asOf);
    return age != null && age >= 0 && age <= 14;
  });
  const hasBullishOptions = options.some((o) => o.sentiment === 'bullish' && optionTiming(o, asOf).eligible && optionPremium(o) > 250_000);

  if (hasInsiderBuy && hasBullishOptions) return 'MEGA_SIGNAL';
  if (hasInsiderBuy) return 'POLITICIAN_INSIDER';
  if (hasBullishOptions) return 'POLITICIAN_OPTIONS';
  return null;
}

/**
 * Data confidence 0–100 — a deterministic completeness/corroboration measure,
 * NOT a quality judgment of the signal itself:
 *   - enrichment fields known (60): market cap 15, earnings 15, sector 5,
 *     track record 10, valuation 5, equity stats 10
 *   - cross-source corroboration (25): 1 source → 5, 2 → 15, 3+ → 25
 *   - authoritative sourcing (15): an eligible trade from EDGAR/OpenInsider
 *     (per-filing exact) rather than aggregator estimates only
 */
export function computeConfidence(agg: TickerAggregate, eligible: RawInsiderTrade[]): number {
  let conf = 0;
  if (agg.marketCap && agg.marketCap > 0) conf += 15;
  if (agg.earningsDate) conf += 15;
  if (agg.sector) conf += 5;
  if (agg.bestAccuracy3m != null) conf += 10;
  if (agg.fairValue) conf += 5 * agg.fairValue.weight;
  else if (agg.upsidePct != null) conf += 5;
  if (agg.stats) conf += 10;
  const sources = agg.sourceCount ?? 1;
  conf += sources >= 3 ? 25 : sources === 2 ? 15 : 5;
  if (eligible.some((t) => t.source === 'edgar' || t.source === 'openinsider')) conf += 15;
  return conf;
}

/**
 * Repair the shares/price/value of an aggregate's trades IN PLACE, dropping rows
 * that cannot be salvaged. `scoreTicker` is pure and works on copies, so this is
 * what the orchestrator calls when the rows it PERSISTS (and the UI renders)
 * should carry the repaired numbers rather than the raw scrape.
 */
export function normalizeAggregateTrades(agg: TickerAggregate): void {
  const out: RawInsiderTrade[] = [];
  for (const t of agg.trades) {
    const sane = sanitizeTradeAmounts(t.shares ?? 0, t.price, t.value ?? 0);
    // Only scoring-eligible rows are repaired; sales/awards are display-only and
    // are kept exactly as scraped so the modal still shows what the source said.
    if (!isScoringEligible(t)) {
      out.push(t);
      continue;
    }
    if (!sane) continue;
    t.shares = sane.shares;
    t.price = sane.price;
    t.value = sane.value;
    out.push(t);
  }
  agg.trades = out;
}

/**
 * Score a single ticker from its merged trades + options.
 * Only transaction types with modifier > 0 contribute; modifier-0 trades
 * (sales, awards, exercise+sale…) are kept for display but score nothing.
 *
 * PURE: the aggregate is never modified, and two calls with the same input
 * always produce the same output.
 */
export function scoreTicker(agg: TickerAggregate, config: ScoringConfig = DEFAULT_SCORING_CONFIG, asOf = Date.now()): ScoredTicker {
  if (agg.fairValue) agg={...agg,fairValue:upgradeFairValue(agg.fairValue,asOf)};
  // Drop/repair impossible share×price×value combos so one glitched scrape
  // cannot mint $quadrillion volumes (e.g. FINS Insider-Monitor unit error).
  // Repaired COPIES — scoring must not mutate its input. Writing the sanitized
  // amounts back onto `agg.trades` made the function non-idempotent: a derived
  // price above MAX_SANE_SHARE_PRICE (shares 1, value $5M) was accepted on the
  // first pass and rejected on the second, so `scoreTicker(agg)` returned 57.1
  // and the shadow-config call right after it, on the same object, returned 0.
  // `normalizeAggregateTrades()` below is what the orchestrator uses when it
  // WANTS the persisted rows repaired for display.
  const eligible: RawInsiderTrade[] = [];
  for (const t of agg.trades) {
    if (!isScoringEligible(t, asOf)) continue;
    const sane = sanitizeTradeAmounts(t.shares ?? 0, t.price, t.value ?? 0);
    if (!sane) continue;
    eligible.push({ ...t, shares: sane.shares, price: sane.price, value: sane.value });
  }

  // Total raw dollar volume across eligible buys (already sanity-bounded).
  const totalDollarVolume = eligible.reduce((sum, t) => {
    const v = Number.isFinite(t.value) ? t.value : 0;
    return v > 0 && v <= MAX_SANE_TRADE_VALUE ? sum + v : sum;
  }, 0);

  // Step 1 — top insider rank + value-weighted type modifier + finance flag.
  // Prefer a non-empty role when ranks tie (empty titles from Insider-Monitor
  // must not block "Chairman and CEO" from Finviz/EDGAR on the same ticker).
  let topWeight = 0;
  let topRole: string | null = null;
  let topName: string | null = null;
  let hasFinance = false;
  let weightedMod = 0;
  let weightTotal = 0;
  for (const t of eligible) {
    const { weight } = getRankWeight(t.role);
    const role = (t.role ?? '').trim();
    if (
      weight > topWeight ||
      (weight === topWeight && role && !(topRole && topRole.trim()))
    ) {
      topWeight = weight;
      topRole = role || t.role || null;
      topName = t.insiderName;
    }
    if (earnsFinanceTimingBonus(t.role)) hasFinance = true;
    const mod = classifyTransaction(t.transactionType).modifier;
    const w = Math.max(t.value > 0 && t.value <= MAX_SANE_TRADE_VALUE ? t.value : 1, 1);
    weightedMod += mod * w;
    weightTotal += w;
  }
  // If still no role, fall back to the largest sane trade's title.
  if (!(topRole && topRole.trim())) {
    const best = [...eligible].sort((a, b) => (b.value || 0) - (a.value || 0)).find((t) => (t.role ?? '').trim());
    if (best) {
      topRole = best.role;
      topName = best.insiderName;
    }
  }
  const rankWeight = topWeight || (eligible.length ? 1 : 0);
  const typeModifier = weightTotal > 0 ? weightedMod / weightTotal : 0;

  // Step 3 — cluster from distinct eligible insiders buying in the last 30 days.
  const recentInsiders = new Set<string>();
  const allInsiders = new Set<string>();
  /** Volume of the trades inside the SAME 30-day window the cluster counts. */
  let recentVolume = 0;
  let freshestAge: number | null = null;
  let tradeDate: string | null = null;
  let filingDate: string | null = null;
  let lateFiling = false;
  for (const t of eligible) {
    const key = normalizeInsiderName(t.insiderName);
    const age = daysBetween(t.tradeDate, asOf);
    // A future-dated trade is a parsing error, never a real filing — it must not
    // count as the freshest signal (see getFreshnessMultiplier).
    const usableAge = age != null && Number.isFinite(age) && age >= 0 ? age : null;
    if (key) {
      allInsiders.add(key);
      if (usableAge != null && usableAge <= 30) {
        recentInsiders.add(key);
        const v = Number.isFinite(t.value) ? t.value : 0;
        if (v > 0 && v <= MAX_SANE_TRADE_VALUE) recentVolume += v;
      }
      if (usableAge != null && (freshestAge == null || usableAge < freshestAge)) {
        freshestAge = usableAge;
        tradeDate = t.tradeDate;
        filingDate = t.filingDate ?? null;
      }
    }
    if (isLateFiling(t.tradeDate, t.filingDate)) lateFiling = true;
  }
  if (!tradeDate && eligible.length) {
    tradeDate = eligible[0].tradeDate || null;
    filingDate = eligible[0].filingDate ?? null;
  }

  // Freshest options scrape age (options are scraped live; used both to date an
  // options-only signal and to decay the options component on its own clock).
  let optionsAge: number | null = null;
  for (const o of agg.options) {
    const timing = optionTiming(o, asOf);
    if (timing.eligible && timing.age !== null && (optionsAge === null || timing.age < optionsAge)) optionsAge = timing.age;
  }
  // Options-only ("whale") signal: no insider trade to date it → use the options age
  // for the freshness badge instead of defaulting to "stale / unknown age".
  if (freshestAge == null && eligible.length === 0 && optionsAge != null) {
    freshestAge = optionsAge;
  }

  // Strictly the last-30-day window (Step 3's contract) — no fallback to all
  // insiders, which would re-grant the full multiplier to months-old clusters.
  const clusterCount = recentInsiders.size;
  const clusterMultiplier = getClusterMultiplier(clusterCount);

  // Step 2 — dollar-volume points on the AVERAGE buy per insider (decorrelates
  // magnitude from cluster count), market-cap-normalized when available.
  //
  // Numerator and denominator MUST describe the same set of trades. They used to
  // not: the denominator counted every eligible insider ever on the aggregate
  // while the cluster multiplier counted only the last 30 days, so adding two
  // genuine but old, small buys diluted the average and LOWERED the score —
  // 2 fresh $1M buys scored 39.4, the same two plus two 200-day-old $10k buys
  // scored 31.7. Both sides now use the 30-day window, with the full set as a
  // fallback when nothing datable falls inside it (so an aggregate whose dates
  // all failed to parse is still scored rather than divided by zero).
  const useRecentWindow = recentInsiders.size > 0;
  const distinctBuyers = useRecentWindow ? recentInsiders.size : Math.max(allInsiders.size, 1);
  const windowVolume = useRecentWindow ? recentVolume : totalDollarVolume;
  const perInsiderValue = windowVolume / distinctBuyers;
  const dollarVolumePoints = getDollarVolumePoints(perInsiderValue, agg.marketCap);

  // Step 4 — earnings timing.
  const insiderTiming = getInsiderTimingMultiplier(agg.daysToEarnings, hasFinance);
  const optionsTimingMultiplier = getOptionsTimingMultiplier(agg.daysToEarnings);

  // Step 5 — detailed options.
  const opts = scoreOptionsDetailed(agg.options, asOf);

  // Context multipliers (knobs threaded from the active ScoringConfig so the
  // shadow framework can score the same aggregate under candidate weights).
  const vixMultiplier = getVixMultiplier(agg.vix, config.vixCap);
  const trackRecordMultiplier = getTrackRecordMultiplier(agg.bestAccuracy3m, config.trackRecordSlope);
  const valuationMultiplier = agg.fairValue?.multiplier ?? getValuationMultiplier(agg.upsidePct);
  // Decay each component on its OWN age: the insider leg by the trade date (badge
  // age), the options leg by its live scrape time — so a stale insider buy doesn't
  // unfairly discount fresh options flow, or vice-versa.
  const freshnessMultiplier = getFreshnessMultiplier(freshestAge, config.freshnessDecayRate, config.freshnessFloor);
  const optionsFreshness = getFreshnessMultiplier(optionsAge, config.freshnessDecayRate, config.freshnessFloor);

  // Congressional leg — live (cluster/alignment-gated) vs legacy (all buys count).
  const politicianResult = getPoliticianScore(agg.politicianTrades ?? [], {
    mode: 'live', asOf,
    insiderTrades: eligible,
  });
  const politicianLegacy = getPoliticianScore(agg.politicianTrades ?? [], { mode: 'legacy', asOf });
  const politicianComboTier = detectPoliticianCombo(agg.politicianTrades ?? [], eligible, agg.options, asOf);

  // Composite legs (shared).
  const insiderRaw =
    rankWeight * dollarVolumePoints * typeModifier * clusterMultiplier * insiderTiming.multiplier * vixMultiplier;
  const optionsRaw = opts.score * optionsTimingMultiplier;
  const legSum = insiderRaw * freshnessMultiplier + optionsRaw * optionsFreshness;
  // Context multipliers scale CONVICTION, so they may only ever amplify a
  // positive reading. Applied to a net-negative leg sum (put-dominated flow
  // outweighing a small insider buy) they inverted: with a politician score
  // added afterwards, a track record of 0.85 scored 69.2 while a track record of
  // 0.20 scored 73.1 — a better insider record produced a WORSE score. Same for
  // valuation (overvalued −30% → 72.6, undervalued +45% → 69.8). Below zero the
  // multipliers are simply not applied; the function stays continuous at 0 and
  // is now monotonically non-decreasing in both.
  const contextMultiplier = trackRecordMultiplier * valuationMultiplier;
  const coreCombined = legSum > 0 ? legSum * contextMultiplier : legSum;

  const combinedLive = coreCombined + politicianResult.score;
  const combinedLegacy = coreCombined + politicianLegacy.score;

  // Saturating normalization (see SCORE_HALF_SATURATION).
  // `finiteOr(…, 0)` before the saturation, not after: a non-finite composite
  // would otherwise make the ratio NaN and every downstream comparison silently
  // false (including the WATCH gate and getConvictionLevel).
  const satLive = Math.max(finiteOr(combinedLive, 0), 0);
  const satLegacy = Math.max(finiteOr(combinedLegacy, 0), 0);
  const normLive = (satLive / (satLive + config.scoreHalfSaturation)) * 100;
  const normLegacy = (satLegacy / (satLegacy + config.scoreHalfSaturation)) * 100;

  const classicCombo = detectCombo(eligible, agg.options, asOf);
  // MEGA already implies insider+options alignment — treat as combo for flags/notifications.
  const comboSignal = classicCombo || politicianComboTier === 'MEGA_SIGNAL';

  // ── LIVE: soft corroboration multiplier + WATCH gate (cannot tier-jump alone) ──
  const softMult = corroborationSoftMult(classicCombo, politicianComboTier);
  const multApplies = softMult > 1 && normLive >= CORROBORATION_GATE;
  const finalScore = clamp(multApplies ? normLive * softMult : normLive, 0, 100);

  // ── LEGACY (shadow): flat +20…+45 post-normalization bonuses ──
  const classicComboBonus = classicCombo ? config.comboBonus : 0;
  const politicianComboBonus = politicianComboTier ? POLITICIAN_COMBO_BONUS[politicianComboTier] : 0;
  const effectiveComboBonus =
    politicianComboTier === 'MEGA_SIGNAL' ? politicianComboBonus : classicComboBonus + politicianComboBonus;
  const legacyScore = clamp(normLegacy + effectiveComboBonus, 0, 100);
  // Approximate "bonus points" for breakdown UI (live mult expressed as delta).
  const liveBonusPoints = Math.round((finalScore - normLive) * 10) / 10;
  const combined = combinedLive;
  const normalizedRaw = normLive;

  const notes: string[] = [];
  if (clusterCount >= 2) notes.push(`${clusterCount} insiders buying (cluster ×${clusterMultiplier})`);
  if (agg.marketCap && agg.marketCap > 0 && totalDollarVolume > 0) {
    notes.push(`Insider buys ≈ ${((totalDollarVolume / agg.marketCap) * 100).toFixed(2)}% of market cap`);
  }
  if (typeModifier < 1) notes.push(`Weighted transaction quality ×${typeModifier.toFixed(2)}`);
  notes.push(...insiderTiming.notes);
  notes.push(...opts.notes);
  if (vixMultiplier > 1) notes.push(`Elevated VIX — insider buying boosted ×${vixMultiplier.toFixed(2)}`);
  if (trackRecordMultiplier > 1) notes.push(`Strong insider track record (×${trackRecordMultiplier.toFixed(2)})`);
  else if (trackRecordMultiplier < 1) notes.push(`Weak insider track record (×${trackRecordMultiplier.toFixed(2)})`);
  if (agg.fairValue) notes.push(`Fair value: level ${agg.fairValue.level}, ${agg.fairValue.status}, ${agg.fairValue.recommendation}; safety margin ${agg.fairValue.marginOfSafety * 100}%`);
  if (valuationMultiplier > 1) notes.push(`Undervalued (~${Math.round(agg.fairValue?.upsidePct ?? agg.upsidePct ?? 0)}% upside, ×${valuationMultiplier})`);
  else if (valuationMultiplier < 1) notes.push(`Overvalued — conviction tempered (×${valuationMultiplier})`);
  if (opts.score < 0) notes.push('🐻 Net bearish options flow (put-dominated)');
  if (freshnessMultiplier < 1) notes.push(`Insider signal age decay ×${freshnessMultiplier.toFixed(2)}`);
  const disposalCount = agg.trades.filter((t) => {
    const c = classifyTransaction(t.transactionType);
    return c.tier === 'excluded' && /sale|sell|dispos|gift given/i.test(c.label);
  }).length;
  if (disposalCount > 0) notes.push(`⚠ ${disposalCount} insider sell/disposal record(s) also on file`);
  // Sell-side intelligence — same-company 90d flow context (display only; a
  // scoring multiplier waits for backtest evidence via the shadow framework).
  if (agg.insiderFlow) {
    const { buys, sells, form144 } = agg.insiderFlow;
    if (agg.insiderFlow.buyCoverage) notes.push('90d buys use dated observed records; source coverage may be incomplete. The insider score uses a 30d pipeline window.');
    if (agg.insiderFlow.unresolvedBuys) notes.push(`${agg.insiderFlow.unresolvedBuys} undated or unresolved purchase record(s) excluded from score and 90d buys.`);
    const fmt = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1_000)}k`);
    if (sells > 250_000 && sells > 3 * Math.max(buys, 1)) {
      notes.push(`⚠ Heavy insider SELLING here: ${fmt(sells)} sold vs ${fmt(buys)} bought (90d)`);
    }
    if (form144 > 0) notes.push(`⚠ ${form144} Form 144 proposed-sale notice(s) filed (90d)`);
  }
  // Equity stats pack — squeeze context + tradeability (display only; scoring
  // integration waits for backtest evidence via the shadow framework).
  if (agg.stats) {
    if (agg.stats.shortPctFloat != null && agg.stats.shortPctFloat >= 15) {
      notes.push(`🔥 High short interest: ${agg.stats.shortPctFloat.toFixed(1)}% of float`);
    }
    if (agg.stats.avgDollarVolume != null && agg.stats.avgDollarVolume < 500_000) {
      notes.push(`⚠ Thin liquidity: ~$${Math.round(agg.stats.avgDollarVolume / 1_000)}k/day average volume`);
    }
    // Price context: insiders buying deep in a drawdown vs chasing near highs.
    if (agg.stats.pctFrom52wHigh != null) {
      const dd = agg.stats.pctFrom52wHigh;
      if (dd <= -40) notes.push(`📉 Buying ${Math.abs(Math.round(dd))}% below the 52-week high — deep-drawdown insider buy`);
      else if (dd >= -5) notes.push(`📈 Buying within ${Math.abs(Math.round(dd))}% of the 52-week high`);
    }
  }
  // 13D/13G radar — activist / large-holder stakes on the same ticker.
  if (agg.filingEvents?.length) {
    for (const f of agg.filingEvents.slice(0, 2)) {
      const kind = f.type.startsWith('SC 13D') ? 'activist stake' : 'large-holder stake';
      notes.push(`⚡ ${f.type} filed${f.filer ? ` by ${f.filer}` : ''} (${kind}, ${f.filedDate})`);
    }
  }
  if (classicCombo && politicianComboTier !== 'MEGA_SIGNAL') {
    if (multApplies) notes.push(`⚡ COMBO: insider + bullish options (×${softMult.toFixed(2)}, gate ≥${CORROBORATION_GATE})`);
    else notes.push(`⚡ COMBO badge — mult gated (base ${normLive.toFixed(0)} < ${CORROBORATION_GATE})`);
  }
  // Congressional leg — names/amounts + the combo tier.
  notes.push(...politicianResult.notes);
  if (politicianComboTier === 'MEGA_SIGNAL') {
    if (multApplies) notes.push(`🚨 MEGA SIGNAL: congress + insider + options (×${MEGA_SOFT_MULT})`);
    else notes.push(`🚨 MEGA SIGNAL badge — mult gated (base ${normLive.toFixed(0)} < ${CORROBORATION_GATE})`);
  } else if (politicianComboTier === 'POLITICIAN_INSIDER') {
    if (multApplies) notes.push(`🏛️ Politician + insider (×${POLITICIAN_INSIDER_SOFT_MULT})`);
    else notes.push(`🏛️ Politician + insider badge — mult gated`);
  } else if (politicianComboTier === 'POLITICIAN_OPTIONS') {
    if (multApplies) notes.push(`🏛️ Politician + options (×${POLITICIAN_OPTIONS_SOFT_MULT})`);
    else notes.push(`🏛️ Politician + options badge — mult gated`);
  }
  notes.push(`Legacy flat-bonus score (shadow): ${legacyScore.toFixed(1)}`);

  // Which of the neutral-valued factors were neutral because their INPUT was
  // missing? A 1.0 that means "no data" is a different statement from a 1.0
  // that means "the data says neutral", and the audit could not tell them apart.
  const dormantFactors: DormantFactor[] = [];
  if (agg.vix == null || !Number.isFinite(agg.vix)) {
    dormantFactors.push({ factor: 'vixMultiplier', reason: 'no VIX reading (stale or unfetched)' });
  }
  if (agg.fairValue ? agg.fairValue.weight === 0 : agg.upsidePct == null || !Number.isFinite(agg.upsidePct)) {
    dormantFactors.push({ factor: 'valuationMultiplier', reason: 'no fair-value estimate available' });
  }
  if (classicCombo && !multApplies) {
    dormantFactors.push({
      factor: 'comboBonus',
      reason: `corroboration gate: base ${normLive.toFixed(0)} < ${CORROBORATION_GATE}`,
    });
  }

  const breakdown: ScoreBreakdown = {
    ...(agg.fairValue ? { fairValue: agg.fairValue } : {}),
    rankWeight,
    dollarVolumePoints,
    typeModifier,
    clusterMultiplier,
    timingMultiplier: insiderTiming.multiplier,
    optionsScore: opts.score,
    optionsTimingMultiplier,
    freshnessMultiplier,
    vixMultiplier,
    trackRecordMultiplier,
    valuationMultiplier,
    // Live: points contributed by soft mult (0 if gated); legacy flat kept in notes/shadow.
    comboBonus: liveBonusPoints,
    optionsBonus: opts.score,
    signalAgeDays: freshestAge,
    rawScore: combined,
    maxPossibleRaw: MAX_POSSIBLE_RAW,
    normalizedScore: finalScore,
    confidence: computeConfidence(agg, eligible),
    politicianScore: politicianResult.score,
    politicianComboTier,
    dormantFactors,
    notes,
  };

  return {
    ticker: agg.ticker,
    companyName: agg.companyName,
    score: Math.round(finalScore * 10) / 10,
    convictionLevel: getConvictionLevel(finalScore),
    totalDollarVolume,
    insiderCount: allInsiders.size,
    topInsiderRole: topRole,
    topInsiderName: topName,
    breakdown,
    tradeDate,
    filingDate,
    lateFiling,
    signalAgeDays: freshestAge,
    comboSignal,
    politicianScore: politicianResult.score,
    politicianComboTier,
    /** Always the pre-change flat-bonus score for A/B comparison (shadow column). */
    legacyScore: Math.round(legacyScore * 10) / 10,
  };
}
