import type { FairValueResult, FundamentalDatum } from '../src/types/fairValue';

export const VALUATION_MODELS = [
  'DCF-FCFF', 'DCF-FCFE', 'DDM/Gordon Growth', '2-stage DDM', 'APV', 'Residual income', 'EVA',
  'Historical P/E', 'Peer P/E', 'Forward P/E', 'PEG', 'Shiller P/E', 'EV/EBIT', 'EV/EBITDA',
  'P/S', 'EV/Sales', 'P/B', 'P/CF', 'P/TBV', 'Dividend yield',
  'NAV', 'Liquidation value', 'Replacement value', 'Stuttgart method', 'Black-Scholes real options', 'SOTP',
] as const;

/** Five explicit annual periods plus Gordon terminal value; rates are decimals. */
export function discountedCashFlow(cash: number, growth: number, discount: number, terminal: number): number {
  if (![cash, growth, discount, terminal].every(Number.isFinite) || cash <= 0 || discount <= terminal || discount <= 0 || growth <= -1) return NaN;
  let pv = 0;
  for (let year = 1; year <= 5; year++) pv += cash * (1 + growth) ** year / (1 + discount) ** year;
  return pv + cash * (1 + growth) ** 5 * (1 + terminal) / (discount - terminal) / (1 + discount) ** 5;
}

/** Three forecast years, then a seven-year linear fade to sustainable growth. */
export function fadingCashFlow(cash: number, growth: number, discount: number, terminal: number): number {
  if (![cash, growth, discount, terminal].every(Number.isFinite) || cash <= 0 || growth <= -1 || discount <= terminal || discount <= 0) return NaN;
  let pv = 0;
  let flow = cash;
  for (let year = 1; year <= 10; year++) {
    const g = year <= 3 ? growth : growth + (terminal - growth) * (year - 3) / 7;
    flow *= 1 + g;
    pv += flow / (1 + discount) ** year;
  }
  return pv + flow * (1 + terminal) / (discount - terminal) / (1 + discount) ** 10;
}

export function realOptionCall(asset: number, exercise: number, years: number, rate: number, volatility: number): number {
  if (![asset, exercise, years, rate, volatility].every(Number.isFinite) || Math.min(asset, exercise, years, volatility) <= 0) return NaN;
  const cdf = (x: number) => {
    const z = Math.abs(x), t = 1 / (1 + 0.2316419 * z);
    const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
  };
  const d1 = (Math.log(asset / exercise) + (rate + volatility ** 2 / 2) * years) / (volatility * Math.sqrt(years));
  return asset * cdf(d1) - exercise * Math.exp(-rate * years) * cdf(d1 - volatility * Math.sqrt(years));
}

/** Only source-backed inputs enter the model. Defaults never count toward a higher level. */
export function calculateFairValue(raw: Record<string, FundamentalDatum>, now = Date.now(), warnings: string[] = []): FairValueResult {
  const inputs = Object.fromEntries(Object.entries(raw).filter(([, d]) =>
    Number.isFinite(d.value) && !!d.source && Number.isFinite(Date.parse(d.fetchedAt)) &&
    now - Date.parse(d.fetchedAt) >= 0 && now - Date.parse(d.fetchedAt) <= 86_400_000));
  const v = (key: string) => inputs[key]?.value;
  const positive = (key: string) => (v(key) ?? 0) > 0;
  const price = positive('price') ? v('price')! : null;
  const models: FairValueResult['models'] = VALUATION_MODELS.map(name => ({ name, value: null, reason: 'Required comparable, historical or model-specific inputs unavailable' }));
  const assumptions: string[] = [];
  const put = (name: string, value: number) => {
    const model = models.find(m => m.name === name)!;
    if (Number.isFinite(value) && value > 0) { model.value = value; delete model.reason; }
  };
  // Do not substitute the company's current trading multiple for a fair peer multiple.
  const multiples: [string, string, string][] = [
    ['Historical P/E', 'eps', 'historicalPE'], ['Peer P/E', 'eps', 'peerPE'],
    ['Forward P/E', 'forwardEPS', 'peerForwardPE'], ['Shiller P/E', 'realEPS10y', 'peerShillerPE'],
    ['P/S', 'salesPerShare', 'peerPS'], ['P/B', 'bookPerShare', 'peerPB'],
    ['P/CF', 'operatingCashPerShare', 'peerPCF'], ['P/TBV', 'tangibleBookPerShare', 'peerPTBV'],
  ];
  for (const [name, metric, multiple] of multiples) if (positive(metric) && positive(multiple)) put(name, v(metric)! * v(multiple)!);
  for (const [name, metric, multiple] of [['EV/EBIT', 'ebit', 'peerEVEBIT'], ['EV/EBITDA', 'ebitda', 'peerEVEBITDA'], ['EV/Sales', 'revenue', 'peerEVSales']]) {
    if (positive(metric) && positive(multiple) && positive('shares') && v('cash') != null && v('debt') != null)
      put(name, (v(metric)! * v(multiple)! + v('cash')! - v('debt')!) / v('shares')!);
  }
  if (positive('eps') && positive('epsGrowth') && positive('peerPEG')) put('PEG', v('eps')! * v('epsGrowth')! * 100 * v('peerPEG')!);
  if (positive('dividend') && positive('peerDividendYield')) put('Dividend yield', v('dividend')! / v('peerDividendYield')!);

  // Only MISSING forecasts use the conservative 2% fallback. Observed forecasts
  // must not be silently crushed to 3% for a fast-growing business.
  const forecasts = [v('epsGrowth'), v('revenueGrowth')].filter((n): n is number => n != null && Number.isFinite(n));
  // EPS/revenue growth is not cashflow guidance: cap this proxy at 25% rather
  // than extrapolating extraordinary growth into a decade-long cashflow path.
  const growthProxy = v('epsGrowth') ?? v('revenueGrowth');
  const growth = growthProxy != null ? Math.min(0.25, Math.max(-0.3, growthProxy)) : 0.02;
  const enterpriseGrowthProxy = v('revenueGrowth') ?? v('epsGrowth');
  const enterpriseGrowth = enterpriseGrowthProxy != null ? Math.min(0.25, Math.max(-0.3, enterpriseGrowthProxy)) : 0.02;
  const terminal = 0.025;
  const adjustedBeta = v('beta') != null && v('beta')! >= 0 && v('beta')! <= 5 ? 0.67 * v('beta')! + 0.33 : undefined;
  const useCapm = v('usdRiskModel') === 1 && adjustedBeta != null;
  const costEquity = v('costEquity') ?? (useCapm ? Math.max(0.07, 0.0425 + adjustedBeta! * 0.05) : 0.10);
  if (v('costEquity') == null && useCapm) assumptions.push(`USD CAPM scenario: 4.25% risk-free rate + adjusted beta (${adjustedBeta!.toFixed(3)} = 0.67 × observed beta + 0.33) × 5% equity premium, with a 7% floor. Rate and premium are explicit policy assumptions, not live market observations; this does not qualify as sourced cost of equity.`);
  const cashflow = v('financialCompany') === 1 ? undefined : v('normalizedFcfePerShare') ?? v('fcfePerShare');
  const scenarios: NonNullable<FairValueResult['scenarios']> = [];
  if (positive('dividend') || (cashflow ?? 0) > 0) {
    assumptions.push(`Per-share DCF: three years at ${(growth * 100).toFixed(1)}% growth (${growthProxy != null ? 'EPS forecast preferred as per-share cashflow proxy; revenue only when EPS forecast is missing; policy cap 25%; raw forecasts shown in inputs' : 'missing-forecast fallback'}), fading over seven years to 2.5%; cost of equity ${(costEquity * 100).toFixed(1)}%${v('costEquity') == null ? ' (assumption; sensitivity shown)' : ''}. EPS can reflect buybacks and accounting effects; it is not direct FCF guidance.`);
  }
  if (positive('dividend') && costEquity > terminal && (!positive('eps') || v('dividend')! / v('eps')! >= 0.4)) {
    put('DDM/Gordon Growth', v('dividend')! * (1 + terminal) / (costEquity - terminal));
    put('2-stage DDM', discountedCashFlow(v('dividend')!, growth, costEquity, terminal));
  }
  if ((cashflow ?? 0) > 0) {
    put('DCF-FCFE', fadingCashFlow(cashflow!, growth, costEquity, terminal));
    if (positive('normalizedFcfePerShare')) assumptions.push('Equity cashflow proxy: FCF per share with neutral future net borrowing. Current debt issuance/repayment is not projected forever; cash is not added again.');
    for (const [name, g, r, t] of [
      ['bear', Math.max(-0.3, growth - 0.05), costEquity + 0.02, 0.02],
      ['base', growth, costEquity, terminal],
      ['bull', Math.min(0.6, growth + 0.05), Math.max(0.065, costEquity - 0.015), 0.03],
    ] as const) {
      const value = fadingCashFlow(cashflow!, g, r, t);
      if (Number.isFinite(value) && value > 0) scenarios.push({ name, value, growth: g, discount: r, terminal: t });
    }
  }
  if (v('financialCompany') !== 1 && positive('fcff') && positive('shares') && positive('wacc') && v('cash') != null && v('debt') != null) {
    put('DCF-FCFF', (fadingCashFlow(v('fcff')!, enterpriseGrowth, v('wacc')!, terminal) + v('cash')! - v('debt')!) / v('shares')!);
    assumptions.push(`FCFF uses the same ten-year fade, with WACC and an explicit cash/debt bridge.`);
  }
  // These require independently supplied asset/segment valuations, not balance-sheet proxies.
  for (const [name, key] of [['NAV', 'navEquity'], ['Liquidation value', 'liquidationEquity'], ['Replacement value', 'replacementEquity'], ['SOTP', 'sotpEquity']]) {
    if (v(key) != null && positive('shares')) put(name, v(key)! / v('shares')!);
  }
  // Specialized models require explicit independently sourced forecasts/PVs.
  // Never substitute total market cap or accounting book value for option/asset appraisals.
  const has = (...keys: string[]) => keys.every(k => v(k) != null);
  if (positive('unleveredCashFlow') && positive('costOfAssets') && positive('shares') && has('taxShieldPV', 'distressPV', 'cash', 'debt')) {
    put('APV', (fadingCashFlow(v('unleveredCashFlow')!, enterpriseGrowth, v('costOfAssets')!, terminal) + v('taxShieldPV')! - v('distressPV')! + v('cash')! - v('debt')!) / v('shares')!);
  }
  if (positive('bookPerShare') && has('residualIncomePVPerShare')) put('Residual income', v('bookPerShare')! + v('residualIncomePVPerShare')!);
  if (positive('investedCapital') && positive('shares') && has('economicProfitPV', 'cash', 'debt')) put('EVA', (v('investedCapital')! + v('economicProfitPV')! + v('cash')! - v('debt')!) / v('shares')!);
  if (positive('shares') && has('stuttgartAdjustedAssets', 'stuttgartWeightedEarnings') && v('stuttgartApplicable') === 1) {
    put('Stuttgart method', 0.68 * (v('stuttgartAdjustedAssets')! + 5 * Math.max(0, v('stuttgartWeightedEarnings')!)) / v('shares')!);
    assumptions.push('Stuttgart: historical 0.68 × (adjusted assets + 5 × weighted earnings), only when expressly applicable; not a modern listed-equity standard.');
  }
  if (positive('shares') && has('optionAssetPV', 'optionExerciseCost', 'optionYears', 'optionRiskFreeRate', 'optionVolatility', 'baseEquityWithoutOption')) {
    put('Black-Scholes real options', (v('baseEquityWithoutOption')! + realOptionCall(v('optionAssetPV')!, v('optionExerciseCost')!, v('optionYears')!, v('optionRiskFreeRate')!, v('optionVolatility')!)) / v('shares')!);
  }

  const relativeCount = models.filter(m => m.value != null && multiples.some(([n]) => n === m.name)).length;
  const absolute = models.some(m => m.value != null && /^DCF/.test(m.name));
  // A default discount rate is not evidence for level 3, and model count is not accuracy.
  const sourcedDiscount = models.some(m => m.value != null && (m.name === 'DCF-FCFF' && positive('wacc') || m.name === 'DCF-FCFE' && positive('costEquity')));
  const level: FairValueResult['level'] = models.every(m => m.value != null) && sourcedDiscount ? 4 : absolute && sourcedDiscount && Object.keys(inputs).length >= 10 ? 3 : (absolute && forecasts.length > 0 && Object.keys(inputs).length >= 5) || relativeCount >= 2 && Object.keys(inputs).length >= 5 ? 2 : 1;
  let values = models.flatMap(m => m.value == null ? [] : [m.value]);
  // Combine independent method families once; two DDM variants are not two votes.
  if (absolute) {
    const groupMedian = (names: string[]) => {
      const group = models.filter(m => names.includes(m.name) && m.value != null).map(m => m.value!).sort((a,b)=>a-b);
      return group.length ? (group[Math.floor((group.length-1)/2)] + group[Math.floor(group.length/2)]) / 2 : null;
    };
    values = [groupMedian(['DCF-FCFE','DCF-FCFF']), groupMedian(['Historical P/E','Peer P/E','Forward P/E','Shiller P/E'])].filter((n): n is number => n != null);
    assumptions.push('Central value uses cashflow and, when available, independently sourced earnings benchmarks. DDM is a cross-check rather than an extra vote when equity cashflow already values the same distributions.');
  }
  let status: FairValueResult['status'] = values.length ? 'estimated' : 'fallback';
  if (!values.length && positive('eps')) {
    const g = growthProxy != null ? Math.max(0, Math.min(0.10, growthProxy)) : 0.02;
    values = [v('eps')! * (8.5 + 2 * g * 100)];
    assumptions.push(`Stage-1 policy fallback: EPS × (8.5 + 2 × forecast growth in percent), growth capped at 10%, missing forecast 2%. Simplified historical Graham heuristic; no bond-yield adjustment, not an observed peer multiple or institutional fair value.`);
  }
  if (!values.length && positive('bookPerShare')) {
    values = [v('bookPerShare')! * 0.5, v('bookPerShare')!];
    assumptions.push('Fallback: 0.5–1.0 × positive book value; asset recoverability unverified.');
  }
  if (!values.length) status = 'unavailable';
  values.sort((a, b) => a - b);
  const median = values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : null;
  const spread = level === 3 ? 0.2 : level === 2 ? 0.3 : 0.4;
  const low = median == null ? null : scenarios.length ? Math.min(...scenarios.map(s => s.value), ...values) : Math.min(values[0], median * (1 - spread));
  const high = median == null ? null : scenarios.length ? Math.max(...scenarios.map(s => s.value), ...values) : Math.max(values[values.length - 1], median * (1 + spread));
  const marginOfSafety = level === 4 ? 0.15 : level === 3 ? 0.2 : level === 2 ? 0.3 : 0.4;
  const weight = status === 'unavailable' || price == null ? 0 : (level === 4 ? 1 : level === 3 ? 0.75 : level === 2 ? 0.4 : 0.15) * (status === 'fallback' ? 0.5 : 1);
  // Apply the safety discount once to the central estimate. The bear scenario
  // already carries a growth/rate stress and must not be discounted twice.
  const entryPrice = median == null ? null : median * (1 - marginOfSafety);
  const upsidePct = price != null && median != null ? (median / price - 1) * 100 : null;
  const mispricingPct = price != null && median != null ? (price / median - 1) * 100 : null;
  const safetyMarginMet = price != null && entryPrice != null && price <= entryPrice;
  const recommendation = weight === 0 ? 'insufficient-data' : mispricingPct! < -5 ? 'undervalued' : mispricingPct! > 5 ? 'overvalued' : 'watch';
  const multiplier = 1 + weight * (safetyMarginMet && recommendation === 'undervalued' ? 0.15 : recommendation === 'overvalued' ? -0.1 : 0);
  return { version: 3, calculatedAt: new Date(now).toISOString(), currency: 'USD', level, status, price, low, high, fairValue: median, scenarios,
    upsidePct, mispricingPct, safetyMarginMet, marginOfSafety, entryPrice, weight, multiplier, recommendation, inputs, assumptions,
    warnings: [...warnings, 'Model corridor is scenario uncertainty, not a statistical confidence interval.', ...(status === 'unavailable' ? ['No positive earnings, book value or supported cashflows; no defensible numerical fallback.'] : [])], models };
}
