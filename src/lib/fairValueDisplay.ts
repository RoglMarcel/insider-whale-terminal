import type { FairValueResult } from '@/types/fairValue';
import { calculateFairValue } from '../../electron/fairValue';
/** Normalize every route and neutralize stale data without changing its historical date. */
export function upgradeFairValue(value: FairValueResult, now=Date.now()): FairValueResult {
  if(!value || !Number.isFinite(Date.parse(value.calculatedAt)))return calculateFairValue({},now,['Invalid saved valuation date.']);
  const warnings=Array.isArray(value.warnings)?value.warnings.filter(w=>typeof w==='string'):[];
  const inputs=value.inputs&&typeof value.inputs==='object'?value.inputs:{};
  let next:FairValueResult;
  if(value.methodology!==4 && Object.keys(inputs).length) {
    next=calculateFairValue(inputs,Date.parse(value.calculatedAt),warnings.filter(w=>!w.startsWith('Model corridor is')),value.currency||'USD');
  } else {
    const positive=(n:unknown):number|null=>typeof n==='number'&&Number.isFinite(n)&&n>0?n:null;
    const level=[1,2,3].includes(value.level)?value.level:1;
    next={...value,version:3,level,inputs,models:Array.isArray(value.models)?value.models:[],warnings,assumptions:Array.isArray(value.assumptions)?value.assumptions:[],price:positive(value.price),fairValue:positive(value.fairValue),low:positive(value.low),high:positive(value.high)};
    if(value.methodology!==4){next.level=1;next.status=next.fairValue==null?'unavailable':'fallback';next.warnings=[...warnings,'Legacy summary has no auditable inputs; refresh full analysis.'];}
    next.marginOfSafety=next.level===3?.2:next.level===2?.3:.4;
    next.entryPrice=next.fairValue==null?null:next.fairValue*(1-next.marginOfSafety);
  }
  next.quote=value.quote;
  next.externalComparisons=Array.isArray(value.externalComparisons)?value.externalComparisons.filter(c=>c&&(c.provider==='fairvaluecalculator'||c.provider==='alphaspread')):undefined;
  next.mispricingPct=next.price!=null&&next.fairValue!=null?(next.price/next.fairValue-1)*100:null;
  next.upsidePct=next.price!=null&&next.fairValue!=null?(next.fairValue/next.price-1)*100:null;
  next.safetyMarginMet=next.price!=null&&next.entryPrice!=null&&next.price<=next.entryPrice;
  const age=now-Date.parse(next.calculatedAt);
  const stale=!Number.isFinite(age)||age<0||age>86400000;
  const quoteAge=next.quote?now-Date.parse(next.quote.asOf):0;
  const staleQuote=!!next.quote&&(!Number.isFinite(quoteAge)||quoteAge<0||quoteAge>5*86400000);
  const legacySummary=value.methodology!==4&&!Object.keys(inputs).length;
  next.status=next.fairValue==null?'unavailable':next.status==='estimated'?'estimated':'fallback';
  next.weight=stale||staleQuote||legacySummary||next.price==null||next.fairValue==null?0:(next.level===3?.75:next.level===2?.4:.15)*(next.status==='fallback'?.5:1);
  next.recommendation=next.weight===0?'insufficient-data':next.mispricingPct! < -5?'undervalued':next.mispricingPct! > 5?'overvalued':'watch';
  next.multiplier=1+next.weight*(next.safetyMarginMet&&next.recommendation==='undervalued'?.15:next.recommendation==='overvalued'?-.1:0);
  if(stale&&!next.warnings.includes('Valuation stale or future-dated; excluded from current score.'))next.warnings=[...next.warnings,'Valuation stale or future-dated; excluded from current score.'];
  if(staleQuote&&!next.warnings.includes('Market reference quote stale or invalid; excluded from current score.'))next.warnings=[...next.warnings,'Market reference quote stale or invalid; excluded from current score.'];
  return next;
}
export function valuationComparison(value?:FairValueResult) {
  if(!value||value.fairValue==null||value.fairValue<=0||value.price==null||value.price<=0)return null;
  return (value.price/value.fairValue-1)*100;
}
