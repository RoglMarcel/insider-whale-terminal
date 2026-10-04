/* Correctness checks for the extended scoring model (Features 1–6, 8). */
import {
  getRankWeight,
  getDollarVolumePoints,
  getClusterMultiplier,
  getInsiderTimingMultiplier,
  getOptionsTimingMultiplier,
  scoreOneOption,
  scoreOptionsDetailed,
  getVixMultiplier,
  getTrackRecordMultiplier,
  getValuationMultiplier,
  detectCombo,
  scoreTicker,
  computeConfidence,
  getPoliticianScore,
  detectPoliticianCombo,
  MAX_POSSIBLE_RAW,
  SCORE_HALF_SATURATION,
} from '../electron/scoring';
import {
  classifyTransaction,
  getFreshnessMultiplier,
  isLateFiling,
  shrunkAccuracy,
  classifyInsiderPattern,
  computeSourceHealth,
  evaluateAlertRules,
  DEFAULT_SCORING_CONFIG,
  type RawInsiderTrade,
  type OptionsActivity,
  type TickerAggregate,
} from '../src/types';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}: got ${JSON.stringify(actual)}${ok ? '' : ` — expected ${JSON.stringify(expected)}`}`);
}
function approx(name: string, actual: number, expected: number, tol = 0.6) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}: got ${actual.toFixed(2)}${ok ? '' : ` — expected ≈ ${expected}`}`);
}

console.log('— Feature 2: transaction classification —');
check('P - Purchase', classifyTransaction('P - Purchase').modifier, 1.0);
check('10b5-1 Purchase', classifyTransaction('10b5-1 Purchase').modifier, 0.4);
check('A - Award (excluded)', classifyTransaction('A - Award').modifier, 0.0);
check('S - Sale (excluded)', classifyTransaction('S - Sale').modifier, 0.0);
check('Exercise + Hold', classifyTransaction('Option Exercise').modifier, 0.5);
check('Conversion', classifyTransaction('C - Conversion').modifier, 0.2);
check('tier strong', classifyTransaction('P - Purchase').tier, 'strong');
check('tier excluded', classifyTransaction('A - Award').tier, 'excluded');

console.log('\n— Feature 1: freshness + late filing —');
check('< 24h', getFreshnessMultiplier(0.5), 1.0);
approx('2 days ≈ 0.79', getFreshnessMultiplier(2), 0.7945, 0.01);
approx('5 days ≈ 0.56', getFreshnessMultiplier(5), 0.5627, 0.01);
approx('10 days ≈ 0.32', getFreshnessMultiplier(10), 0.3166, 0.01);
check('20 days → 0.15 floor (backtest 2026-07-03)', getFreshnessMultiplier(20), 0.15);
check('late filing (8 business days)', isLateFiling('2026-06-01', '2026-06-12'), true);
check('on-time filing (2 days)', isLateFiling('2026-06-10', '2026-06-12'), false);

console.log('\n— Feature 5: earnings timing —');
check('insider 3d', getInsiderTimingMultiplier(3, false).multiplier, 1.8);
check('insider 3d + finance', Math.round(getInsiderTimingMultiplier(3, true).multiplier * 100) / 100, 2.34);
check('insider 10d', getInsiderTimingMultiplier(10, false).multiplier, 1.5);
check('insider 20d', getInsiderTimingMultiplier(20, false).multiplier, 1.3);
check('insider none', getInsiderTimingMultiplier(undefined, true).multiplier, 1.0);
check('options 3d', getOptionsTimingMultiplier(3), 2.0);
check('options 10d', getOptionsTimingMultiplier(10), 1.6);
check('options none', getOptionsTimingMultiplier(undefined), 1.0);

console.log('\n— Feature 3: options scoring —');
const maxedOption: OptionsActivity = {
  ticker: 'X', type: 'call', sentiment: 'bullish', notional: 2_500_000, premiumTotal: 2_500_000,
  isSweep: true, scrapedAt: new Date().toISOString(), dte: 14, otmPercent: 20, volOiRatio: 12, source: 'barchart',
};
approx('maxed single option = 78.6', scoreOneOption(maxedOption), 78.624, 0.1);
approx('detailed net (bullish)', scoreOptionsDetailed([maxedOption]).score, 78.624, 0.1);
const bearPut: OptionsActivity = { ticker: 'X', type: 'put', sentiment: 'bearish', notional: 2_500_000, source: 'barchart' };
check('bearish put subtracts', scoreOptionsDetailed([bearPut]).score < 0, true);

console.log('\n— Expired options do not earn the short-dated boost —');
const expiredOpt: OptionsActivity = { ticker: 'X', type: 'call', sentiment: 'bullish', notional: 600_000, scrapedAt: new Date().toISOString(), dte: -2, source: 'barchart' };
check('negative DTE → no near-term ×1.5', scoreOneOption(expiredOpt), 0);
check('DTE 10 → near-term ×1.5', scoreOneOption({ ...expiredOpt, dte: 10 }), 13.5);

console.log('\n— Track-record shrinkage (anti-fluke) —');
approx('1-for-1 shrinks to ~0.625', shrunkAccuracy(1, 1), 0.625, 0.001);
approx('5-for-5 → ~0.8125', shrunkAccuracy(5, 5), 0.8125, 0.001);
approx('8-of-10 → ~0.731', shrunkAccuracy(8, 10), 0.7308, 0.001);
check('empty record → 0.5 baseline', shrunkAccuracy(0, 0), 0.5);

console.log('\n— Routine vs opportunistic insider pattern —');
check('first-ever buy → opportunistic', classifyInsiderPattern(['2026-06-01']), 'opportunistic');
check('same month across years → routine', classifyInsiderPattern(['2023-03-10', '2024-03-05', '2025-03-12']), 'routine');
check('mixed months → no claim', classifyInsiderPattern(['2023-03-10', '2024-07-05', '2025-11-12']), null);
check('same-month cluster in ONE year → not routine', classifyInsiderPattern(['2025-03-01', '2025-03-15', '2025-03-20']), null);
check('two buys → no claim', classifyInsiderPattern(['2024-01-01', '2025-06-01']), null);
check('empty history → no claim', classifyInsiderPattern([]), null);

console.log('\n— Shadow scoring config threading —');
{
  const d = new Date();
  const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cfgAgg: TickerAggregate = {
    ticker: 'CFG',
    trades: [
      { ticker: 'CFG', insiderName: 'A B', role: 'CEO', transactionType: 'P - Purchase', tradeDate: localToday, shares: 100, value: 600_000, source: 'openinsider' },
    ],
    options: [],
    sourceUrls: [],
  };
  const base = scoreTicker(cfgAgg);
  const half = scoreTicker(cfgAgg, { ...DEFAULT_SCORING_CONFIG, scoreHalfSaturation: 210 });
  check('higher half-saturation → lower score', half.score < base.score, true);
  const noCombo = scoreTicker(
    { ...cfgAgg, options: [{ ticker: 'CFG', type: 'call', sentiment: 'bullish', notional: 300_000, source: 'barchart' }] },
    { ...DEFAULT_SCORING_CONFIG, comboBonus: 0 },
  );
  const withCombo = scoreTicker({
    ...cfgAgg,
    options: [{ ticker: 'CFG', type: 'call', sentiment: 'bullish', notional: 300_000, source: 'barchart' }],
  });
  // Live score uses soft mult (config.comboBonus only affects legacy/shadow).
  check(
    'comboBonus 0 config removes the legacy flat bonus',
    (withCombo.legacyScore ?? 0) - (noCombo.legacyScore ?? 0) >= 25,
    true,
  );
  check('default config === implicit default', scoreTicker(cfgAgg, DEFAULT_SCORING_CONFIG).score, base.score);
  check('legacyScore always populated for shadow A/B', base.legacyScore != null, true);
  approx('freshness floor override respected', getFreshnessMultiplier(60, 0.115, 0.3), 0.3, 0.001);
}

console.log('\n— Congressional (politician) scoring —');
{
  const today2 = new Date();
  const ymd2 = `${today2.getFullYear()}-${String(today2.getMonth() + 1).padStart(2, '0')}-${String(today2.getDate()).padStart(2, '0')}`;
  const pol = (name: string, type: 'buy' | 'sell', amt: number, committee?: string, dtd = 10): import('../src/types').PoliticianTrade => ({
    politician: name, chamber: 'House', party: 'Democrat', committee, ticker: 'TEST',
    transactionType: type, amountMidpoint: amt, tradeDate: ymd2, disclosureDate: ymd2, daysToDisclose: dtd, scrapedAt: new Date().toISOString(),
  });
  // Live mode: lone politician print is badge-only (score 0).
  check('lone buy live → 0 (badge only)', getPoliticianScore([pol('A B', 'buy', 750_000)]).score, 0);
  // Legacy mode preserves original additive points.
  approx('legacy single $750k buy → ~20', getPoliticianScore([pol('A B', 'buy', 750_000)], { mode: 'legacy' }).score, 20, 0.5);
  approx('legacy finance committee ×1.5 → ~30', getPoliticianScore([pol('A B', 'buy', 750_000, 'Financial Services')], { mode: 'legacy' }).score, 30, 0.5);
  // 3 distinct buyers → cluster ×2.5 — live scores this (cluster ≥ 2)
  approx('3-politician cluster ×2.5 → ~150', getPoliticianScore([pol('A B', 'buy', 750_000), pol('C D', 'buy', 750_000), pol('E F', 'buy', 750_000)]).score, 150, 1);
  check('lone sell floors at 0', getPoliticianScore([pol('A B', 'sell', 750_000)]).score, 0);
  // Late disclosure: legacy ×0.8 → 16; live with insider alignment ×0.5 → 10
  approx('late disclosure legacy ×0.8 → ~16', getPoliticianScore([pol('A B', 'buy', 750_000, undefined, 45)], { mode: 'legacy' }).score, 16, 0.5);
  const buyTradeAlign: import('../src/types').RawInsiderTrade = {
    ticker: 'TEST', insiderName: 'Ins', role: 'CEO', transactionType: 'P - Purchase', tradeDate: ymd2, shares: 1, value: 500_000, source: 'openinsider',
  };
  approx(
    'late disclosure live ×0.5 with insider align → ~10',
    getPoliticianScore([pol('A B', 'buy', 750_000, undefined, 45)], { mode: 'live', insiderTrades: [buyTradeAlign] }).score,
    10,
    0.5,
  );
  check('empty → 0', getPoliticianScore([]).score, 0);

  // Combo tiers
  const buyTrade = buyTradeAlign;
  const bullOpt: import('../src/types').OptionsActivity = { ticker: 'TEST', type: 'call', sentiment: 'bullish', notional: 300_000, source: 'barchart' };
  check('politician+insider+options → MEGA_SIGNAL', detectPoliticianCombo([pol('A B', 'buy', 100_000)], [buyTrade], [bullOpt]), 'MEGA_SIGNAL');
  check('politician+insider → POLITICIAN_INSIDER', detectPoliticianCombo([pol('A B', 'buy', 100_000)], [buyTrade], []), 'POLITICIAN_INSIDER');
  check('politician+options → POLITICIAN_OPTIONS', detectPoliticianCombo([pol('A B', 'buy', 100_000)], [], [bullOpt]), 'POLITICIAN_OPTIONS');
  check('politician sell only → null', detectPoliticianCombo([pol('A B', 'sell', 100_000)], [buyTrade], [bullOpt]), null);
  check('no politician → null', detectPoliticianCombo([], [buyTrade], [bullOpt]), null);

  // scoreTicker integration: MEGA replaces the +30 combo with +45, politician score folds in.
  const megaAgg: import('../src/types').TickerAggregate = {
    ticker: 'TEST', trades: [buyTrade], options: [bullOpt], politicianTrades: [pol('A B', 'buy', 750_000, 'Financial Services')], sourceUrls: [],
  };
  const megaScored = scoreTicker(megaAgg);
  check('MEGA tier on composite', megaScored.politicianComboTier, 'MEGA_SIGNAL');
  check('politicianScore > 0 in breakdown', megaScored.breakdown.politicianScore! > 0, true);
  check('MEGA note present', megaScored.breakdown.notes.some((n) => n.includes('MEGA SIGNAL')), true);
  check('regular COMBO note suppressed under MEGA', megaScored.breakdown.notes.some((n) => n.startsWith('⚡ COMBO')), false);
}

console.log('\n— Data confidence score —');
const bareAgg: TickerAggregate = {
  ticker: 'X',
  trades: [{ ticker: 'X', insiderName: 'A', role: '', transactionType: 'P - Purchase', tradeDate: '2026-06-01', shares: 1, value: 100_000, source: 'quiverquant' }],
  options: [],
  sourceUrls: [],
  sourceCount: 1,
};
check('bare single-aggregator signal → low (5)', computeConfidence(bareAgg, bareAgg.trades), 5);
const richAgg: TickerAggregate = {
  ...bareAgg,
  trades: [{ ...bareAgg.trades[0], source: 'openinsider' }],
  marketCap: 1e9,
  earningsDate: '2026-08-01',
  sector: 'Tech',
  bestAccuracy3m: 0.6,
  upsidePct: 10,
  stats: { shortPctFloat: 5 },
  sourceCount: 3,
};
check('fully-enriched EDGAR-corroborated → 100', computeConfidence(richAgg, richAgg.trades), 100);
check('two sources, cap+earnings only → 60', computeConfidence({ ...bareAgg, marketCap: 1e9, earningsDate: '2026-08-01', sourceCount: 2 }, [{ ...bareAgg.trades[0], source: 'openinsider' }]), 60);

console.log('\n— Custom alert rules (crossing semantics) —');
const mkSig = (ticker: string, score: number, extra: Partial<import('../src/types').Signal> = {}) =>
  ({
    ticker, score, convictionLevel: score >= 80 ? 'HIGH' : score >= 50 ? 'WATCH' : 'LOW',
    totalDollarVolume: 1, insiderCount: 1, topInsiderRole: null, optionsActivity: [], rawTrades: [],
    breakdown: {} as import('../src/types').ScoreBreakdown, scrapedAt: new Date().toISOString(), sourceUrls: [],
    ...extra,
  }) as import('../src/types').Signal;
const scoreRule: import('../src/types').AlertRule = { id: 1, scope: 'global', condition: 'score_gte', threshold: 70, enabled: true };
check(
  'score crossing fires once',
  evaluateAlertRules([scoreRule], [mkSig('AAA', 75)], [mkSig('AAA', 60)], []).length,
  1,
);
check(
  'score already above → no re-fire',
  evaluateAlertRules([scoreRule], [mkSig('AAA', 76)], [mkSig('AAA', 75)], []).length,
  0,
);
check(
  'cold start (no previous session) fires nothing',
  evaluateAlertRules([scoreRule], [mkSig('AAA', 90)], [], []).length,
  0,
);
check(
  'ticker scope filters other tickers',
  evaluateAlertRules(
    [{ id: 2, scope: 'ticker', ticker: 'BBB', condition: 'score_gte', threshold: 70, enabled: true }],
    [mkSig('AAA', 90), mkSig('BBB', 90)],
    [mkSig('AAA', 10), mkSig('BBB', 10)],
    [],
  ).map((h) => h.ticker),
  ['BBB'],
);
check(
  'watchlist scope + new combo',
  evaluateAlertRules(
    [{ id: 3, scope: 'watchlist', condition: 'new_combo', enabled: true }],
    [mkSig('CCC', 55, { comboSignal: true }), mkSig('DDD', 55, { comboSignal: true })],
    [mkSig('CCC', 50), mkSig('DDD', 50, { comboSignal: true })],
    ['CCC'],
  ).map((h) => h.ticker),
  ['CCC'],
);
check(
  'disabled rule never fires',
  evaluateAlertRules([{ ...scoreRule, enabled: false }], [mkSig('AAA', 99)], [mkSig('AAA', 10)], []).length,
  0,
);
check(
  'cluster crossing fires',
  evaluateAlertRules(
    [{ id: 4, scope: 'global', condition: 'cluster_gte', threshold: 3, enabled: true }],
    [mkSig('EEE', 40, { insiderCount: 3 })],
    [mkSig('EEE', 40, { insiderCount: 2 })],
    [],
  ).length,
  1,
);

console.log('\n— Source health (silent-rot detection) —');
const healthyRun = { openinsider: 50, finviz: 20 };
const brokenRun = { openinsider: 0, finviz: 22 };
check(
  'zero rows ×2 with healthy median → flagged',
  computeSourceHealth(['openinsider', 'finviz'], [brokenRun, brokenRun, healthyRun, healthyRun, healthyRun]).map((i) => i.source),
  ['openinsider'],
);
check(
  'single zero run → not flagged',
  computeSourceHealth(['openinsider'], [brokenRun, healthyRun, healthyRun, healthyRun]).length,
  0,
);
check(
  'chronically-empty source → never flagged',
  computeSourceHealth(['optionstrat'], [{ optionstrat: 0 }, { optionstrat: 0 }, { optionstrat: 0 }, { optionstrat: 0 }, { optionstrat: 0 }]).length,
  0,
);
check(
  'too little history → not flagged',
  computeSourceHealth(['openinsider'], [brokenRun, brokenRun, healthyRun]).length,
  0,
);
check(
  'runs without the source do not count',
  computeSourceHealth(['openinsider'], [brokenRun, brokenRun, {}, {}, healthyRun, healthyRun, healthyRun]).map((i) => i.consecutiveZeroRuns),
  [2],
);

console.log('\n— Features 6 + 8: context multipliers —');
check('VIX 20 → 1.0 (ramp floor)', getVixMultiplier(20), 1.0);
approx('VIX 30 → ~1.10 (ramp)', getVixMultiplier(30), 1.1, 0.001);
check('VIX 40 → 1.15 (ramp cap)', getVixMultiplier(40), 1.15);
approx('track 0.8 → ~1.20', getTrackRecordMultiplier(0.8), 1.195, 0.001);
approx('track 0.3 → 0.87', getTrackRecordMultiplier(0.3), 0.87, 0.001);
approx('track 0.55 → ~1.03', getTrackRecordMultiplier(0.55), 1.0325, 0.001);
check('track coin-flip → 1.0', getTrackRecordMultiplier(0.5), 1.0);
check('track unknown → 1.0', getTrackRecordMultiplier(undefined), 1.0);

console.log('\n— Market-cap-normalized buy size + role weights —');
check('1% of cap → 20 pts', getDollarVolumePoints(5_000_000, 500_000_000), 20);
check('0.1% of cap → 14 pts', getDollarVolumePoints(1_000_000, 1_000_000_000), 14);
check('$5M in a $2T mega-cap → 1 pt', getDollarVolumePoints(5_000_000, 2_000_000_000_000), 1);
check('no cap → absolute bucket ($600k → 10)', getDollarVolumePoints(600_000), 10);
check('10% owner weight 5', getRankWeight('10% Owner').weight, 5);
check('founder weight 8', getRankWeight('Founder').weight, 8);
check('CEO still 10', getRankWeight('Chief Executive Officer').weight, 10);

console.log('\n— normalization —');
// Display reference only (never divides a real score). Rose 2662 → 2855 in v1.1.10
// when the options premium ladder gained rungs above $2M (top base 18 → 26).
approx('MAX_POSSIBLE_RAW ≈ 2855 (display reference)', MAX_POSSIBLE_RAW, 2855.04, 2);
approx('SCORE_HALF_SATURATION ≈ 105', SCORE_HALF_SATURATION, 105, 0.6);

console.log('\n— Feature 10: valuation multiplier —');
check('+45% upside → 1.15', getValuationMultiplier(45), 1.15);
check('+20% upside → 1.08', getValuationMultiplier(20), 1.08);
check('overvalued -30% → 0.9', getValuationMultiplier(-30), 0.9);
check('mild upside +5% → 1.0', getValuationMultiplier(5), 1.0);
check('unknown → 1.0', getValuationMultiplier(undefined), 1.0);

// LOCAL calendar date — daysBetween anchors date-only strings to local
// midnight, so a UTC-derived "today" reads ~1 day old in west-of-UTC evenings
// / east-of-UTC early mornings and trips the freshness check.
const todayD = new Date();
const today = `${todayD.getFullYear()}-${String(todayD.getMonth() + 1).padStart(2, '0')}-${String(todayD.getDate()).padStart(2, '0')}`;
const mk = (name: string, role: string, value: number, type = 'P - Purchase'): RawInsiderTrade => ({
  ticker: 'TEST', insiderName: name, role, transactionType: type, tradeDate: today, shares: 1000, value, source: 'openinsider',
});
const baseTrades: RawInsiderTrade[] = [
  mk('Alice', 'Chief Executive Officer', 200_000),
  mk('Bob', 'Director', 150_000),
  mk('Carol', 'Chief Financial Officer', 150_000),
  mk('Dan', 'VP Sales', 100_000),
];

console.log('\n— Feature 4: combo detection —');
const bigOption: OptionsActivity = { ticker: 'TEST', type: 'call', sentiment: 'bullish', notional: 2_500_000, premiumTotal: 2_500_000, isSweep: true, scrapedAt: new Date().toISOString(), dte: 14, otmPercent: 20, volOiRatio: 12, source: 'barchart' };
check('combo when insider + $250k+ options', detectCombo(baseTrades, [bigOption]), true);
check('no combo without options', detectCombo(baseTrades, []), false);

console.log('\n— Composite: CEO cluster, $600k, earnings 3d, VIX 30, combo —');
const agg: TickerAggregate = { ticker: 'TEST', trades: baseTrades, options: [bigOption], daysToEarnings: 3, vix: 30, sourceUrls: [] };
const scored = scoreTicker(agg);
check('typeModifier 1.0 (all open-market)', scored.breakdown.typeModifier, 1);
check('clusterMultiplier 3.0 (4 insiders)', scored.breakdown.clusterMultiplier, 3);
// 1.8 for "earnings in 0-5 days", and NO finance bonus on top: the only finance
// insider here is a CFO, whose rank weight of 8 already pays for seeing the
// numbers first. Charging the x1.3 as well counted that fact twice
// (docs/audit/FACTORS.md §1, resolved in v1.5.0).
check('insider timing 1.8 (3d, CFO finance bonus NOT double-counted)', Math.round(scored.breakdown.timingMultiplier * 100) / 100, 1.8);
// The bonus still exists — it applies to a finance insider the rank does not
// already reward.
const treasurerAgg: TickerAggregate = { ...agg, trades: [...baseTrades, mk('Erin', 'Treasurer', 120_000)] };
check(
  'insider timing 2.34 (3d + a finance insider the rank does NOT reward)',
  Math.round(scoreTicker(treasurerAgg).breakdown.timingMultiplier * 100) / 100,
  2.34,
);
// An unparsed title is UNKNOWN (weight 4), not the lowest rank (was 1).
check('unknown role weight 4', getRankWeight('').weight, 4);
check('unknown role category', getRankWeight('').category, 'unknown');
// Dormant factors are reported rather than silently neutral.
check(
  'valuation reported dormant (no fair-value provider)',
  (scored.breakdown.dormantFactors ?? []).some((d) => d.factor === 'valuationMultiplier'),
  true,
);
check('VIX not dormant when a reading exists', (scored.breakdown.dormantFactors ?? []).some((d) => d.factor === 'vixMultiplier'), false);
approx('vix multiplier ≈ 1.10 (ramp at VIX 30)', scored.breakdown.vixMultiplier, 1.1, 0.01);
check('freshness 1.0 (today)', scored.breakdown.freshnessMultiplier, 1);
check('comboSignal true', scored.comboSignal, true);
check('legacyScore ≥ live score (flat bonus was larger)', (scored.legacyScore ?? 0) >= scored.score - 0.1, true);
// Soft mult ×1.2 on high base still clamps near 100 → HIGH
// Explicitly fresh options clock: raw 454.248, saturation 105, classic soft factor 1.2.
approx('final score high with fresh observed options', scored.score, 100 * 454.248 / (454.248 + 105) * 1.2, 0.1);
check('conviction HIGH', scored.convictionLevel, 'HIGH');
check('legacy flat score near 100', (scored.legacyScore ?? 0) >= 95, true);

console.log('\n— Whale (options-only) signals score on their own —');
const whaleOption: OptionsActivity = {
  ticker: 'WHL', type: 'call', sentiment: 'bullish', notional: 3_000_000, premiumTotal: 3_000_000,
  isSweep: true, dte: 10, otmPercent: 18, volOiRatio: 12, source: 'barchart',
  scrapedAt: new Date().toISOString(),
};
const whaleAgg: TickerAggregate = { ticker: 'WHL', trades: [], options: [whaleOption], sourceUrls: [] };
const whale = scoreTicker(whaleAgg);
check('whale scores > 0 with no insider trades', whale.score > 0, true);
check('whale has 0 insiders', whale.insiderCount, 0);
check('whale is not a combo (no insider leg)', whale.comboSignal, false);
check('whale dated by options scrape → fresh (×1.0)', whale.breakdown.freshnessMultiplier, 1);

console.log('\n— Excluded types contribute nothing —');
const onlyAwards: TickerAggregate = { ticker: 'Z', trades: [mk('E', 'CEO', 9_000_000, 'A - Award')], options: [], sourceUrls: [] };
const z = scoreTicker(onlyAwards);
check('award-only volume 0', z.totalDollarVolume, 0);
check('award-only score 0', z.score, 0);

console.log(`\n${failures === 0 ? '✅ ALL SCORING CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
