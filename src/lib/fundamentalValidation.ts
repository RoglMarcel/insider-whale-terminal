import type { FundamentalDatum } from '../types/fairValue';
const ratio = /^(peer|historical|pe$|forwardPE$|ps$|pb$|pcf$|ptbv$|peg$|evEbit|evSales|beta$)/;
const decimal = /Growth$|^(wacc|costEquity|costOfAssets|taxRate|roe|roic|payoutRatio|dividendYield|peerDividendYield)$/;
export function fundamentalUnit(key: string): NonNullable<FundamentalDatum['unit']> {
  if (/^(financialCompany|usdRiskModel|stuttgartApplicable)$/.test(key)) return 'flag';
  if (decimal.test(key)) return 'decimal';
  if (ratio.test(key) || /Years$|Volatility$|Rate$/.test(key)) return 'ratio';
  if (key === 'shares') return 'shares';
  if (/PerShare$|^(price|eps|forwardEPS|realEPS10y|dividend|analystTarget)$/.test(key)) return 'currency/share';
  return 'currency';
}
export function validateFundamentals(raw: Record<string, FundamentalDatum>, now: number, currency: string, warnings: string[]) {
  const inputs: Record<string, FundamentalDatum> = {};
  const anchor=raw?.fcff || raw?.fcf || raw?.operatingCash || raw?.eps;
  for (const [key,d] of Object.entries(raw ?? {})) {
    if (!d || !Number.isFinite(d.value) || Math.abs(d.value)>1e16 || !d.source || !Number.isFinite(Date.parse(d.fetchedAt)) || now-Date.parse(d.fetchedAt)<0 || now-Date.parse(d.fetchedAt)>86400000) continue;
    const unit = fundamentalUnit(key);
    let problem = d.unit && d.unit !== unit ? 'inconsistent unit' : '';
    if ((unit === 'currency' || unit === 'currency/share') && d.currency && d.currency !== currency) problem = 'currency mismatch';
    if (unit === 'decimal' && /^(wacc|costEquity|costOfAssets|taxRate|dividendYield|peerDividendYield)$/.test(key) && Math.abs(d.value)>1) problem = 'rate outside decimal range';
    if (d.asOf && (!Number.isFinite(Date.parse(d.asOf)) || Date.parse(d.asOf)>now)) problem = 'invalid reporting date';
    if (/^(fcff|fcf|fcfePerShare|fcfProxyPerShare|normalizedFcfePerShare|eps|revenue|ebit|ebitda|cash|debt|operatingCash|bookPerShare|salesPerShare|operatingCashPerShare|shares)$/.test(key) && anchor?.asOf && d.asOf && anchor.asOf!==d.asOf) problem='inconsistent reporting period';
    if (/^(eps|revenue|ebit|ebitda|operatingCash|fcf|fcff)$/.test(key) && anchor?.period && anchor.period!=='unknown' && d.period && d.period!=='unknown' && anchor.period!==d.period) problem='inconsistent FY/TTM basis';
    if (problem) { warnings.push(`${key}: ${problem}; excluded`); continue; }
    inputs[key] = d;
  }
  // Per-share fields spanning a split may not be mixed with a current share count.
  const split = inputs.shares?.splitAdjustedAsOf;
  for (const [key,d] of Object.entries(inputs)) if (split && fundamentalUnit(key)==='currency/share' && d.splitAdjustedAsOf && d.splitAdjustedAsOf!==split) {
    delete inputs[key]; warnings.push(`${key}: inconsistent split basis; excluded`);
  }
  const fcf=inputs.fcf?.value,shares=inputs.shares?.value,perShare=inputs.fcfPerShare?.value;
  if(fcf!=null && shares!=null && shares>0 && perShare!=null && perShare!==0 && Math.abs(fcf/shares/perShare-1)>.1) {
    for(const key of ['shares','fcfProxyPerShare','normalizedFcfePerShare','fcfePerShare','salesPerShare','operatingCashPerShare'])delete inputs[key];
    warnings.push('FCF/shares conflicts with reported FCF per share; units, period or split basis require review. Share-dependent models withheld.');
  }
  return inputs;
}
