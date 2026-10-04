import { describe, it, expect } from 'vitest';
import { calculateFairValue } from '../electron/fairValue';
import { upgradeFairValue } from '../src/lib/fairValueDisplay';
import { earliestEntryDate } from '../src/lib/portfolio-rules';
import { AsyncCache } from '../src/lib/asyncCache';
import { peerInputs } from '../src/lib/valuationPeers';
import { reduceSoftwareUpdate } from '../src/types/softwareUpdate';
import { parseSecAnnual } from '../electron/scraper/secFundamentals';
import { scoreTicker } from '../electron/scoring';
import { aggregate,trade } from './helpers';
const now = Date.parse('2026-10-04T12:00:00Z');
const data = (values: Record<string, number>) => Object.fromEntries(Object.entries(values).map(([key,value]) => [key,{value,source:'https://example.com/filing',fetchedAt:new Date(now).toISOString()}]));
describe('valuation integrity regressions', () => {
  it('recognizes EV benchmarks as suitable relative valuation', () => {
    const r = calculateFairValue(data({price:20,ebit:100,ebitda:120,peerEVEBIT:10,peerEVEBITDA:9,shares:50,cash:100,debt:200}),now);
    expect(r.level).toBe(2);
  });
  it('never promotes a cashflow model without a growth forecast to level 3', () => {
    const r = calculateFairValue(data({fcfePerShare:10,costEquity:.1,price:30,eps:5,revenue:200,ebit:20,shares:10,cash:10,debt:10,dividend:2}),now);
    expect(r.level).toBe(1);
  });
  it('neutralizes a stored current-format valuation when stale', () => {
    const r=calculateFairValue(data({price:20,eps:5}),now);
    const next=upgradeFairValue(r,now+2*86400000);
    expect(next.weight).toBe(0); expect(next.multiplier).toBe(1);
  });
  it('uses winter, summer and Thanksgiving early closing auctions', () => {
    expect(earliestEntryDate('2026-01-05T20:30:00Z')).toBe('2026-01-05');
    expect(earliestEntryDate('2026-07-06T20:00:00Z')).toBe('2026-07-07');
    expect(earliestEntryDate('2026-11-27T18:00:00Z')).toBe('2026-11-28');
  });
  it('does not count flags, derived duplicates or assumption sources as quality',()=>{
    const inputs=data({price:20,fcfePerShare:5,costEquity:.1,epsGrowth:.1,beta:1,usdRiskModel:1,eps:4,revenue:300,cash:5,debt:10});
    const r=calculateFairValue({...inputs,costEquity:{...inputs.costEquity,origin:'assumption',asOf:'2026-09-30',period:'forecast'}},now);
    expect(r.level).toBe(2);expect(r.missingQualityInputs?.length).toBeGreaterThan(0);
  });
  it('requires dated coherent evidence for level 3, independently of field count',()=>{
    const inputs=Object.fromEntries(Object.entries(data({price:20,fcfePerShare:5,costEquity:.1,epsGrowth:.1})).map(([k,d])=>[k,{...d,origin:'reported' as const,asOf:'2026-09-30',period:'TTM' as const}]));
    expect(calculateFairValue(inputs,now).level).toBe(3);
  });
  it('checks currencies, units, periods and split bases before calculation',()=>{
    const input=data({eps:5,price:20,shares:10,fcf:100});
    expect(calculateFairValue({...input,eps:{...input.eps,currency:'EUR'}},now).inputs.eps).toBeUndefined();
    expect(calculateFairValue({...input,shares:{...input.shares,unit:'currency'}},now).inputs.shares).toBeUndefined();
    expect(calculateFairValue({...input,fcf:{...input.fcf,asOf:'2026-06-30'},eps:{...input.eps,asOf:'2025-12-31'}},now).inputs.eps).toBeUndefined();
    expect(calculateFairValue({...input,shares:{...input.shares,splitAdjustedAsOf:'2026-09-01'},eps:{...input.eps,splitAdjustedAsOf:'2020-01-01'}},now).inputs.eps).toBeUndefined();
    expect(calculateFairValue({...input,...data({fcfPerShare:10000000,fcfProxyPerShare:10})},now).inputs.fcfProxyPerShare).toBeUndefined();
  });
  it('keeps market deviation distinct from upside and safety price',()=>{
    const r=calculateFairValue(data({price:50,eps:8}),now);
    expect(r.fairValue).toBe(100);expect(r.mispricingPct).toBe(-50);expect(r.upsidePct).toBe(100);expect(r.entryPrice).toBe(60);
  });
  it('keeps correlated relative methods to one central family vote',()=>{
    const a=calculateFairValue(data({eps:5,peerPE:10,bookPerShare:10,peerPB:2}),now);
    const b=calculateFairValue(data({eps:5,peerPE:10,historicalPE:10,forwardEPS:5,peerForwardPE:10,bookPerShare:10,peerPB:2}),now);
    expect(a.fairValue).toBe(35);expect(b.fairValue).toBe(a.fairValue);
  });
  it('prevents stale valuation weight from entering newly persisted score breakdowns',()=>{
    const valuation=calculateFairValue(data({eps:8,price:50}),now);
    const scored=scoreTicker(aggregate({trades:[trade()],fairValue:valuation}),undefined,now+2*86400000);
    expect(scored.breakdown.fairValue?.weight).toBe(0);expect(scored.breakdown.valuationMultiplier).toBe(1);
  });
  it('validates legacy summaries and malformed timestamps without inventing inputs',()=>{
    const r=calculateFairValue(data({eps:8,price:50}),now);
    const legacy=upgradeFairValue({...r,methodology:undefined,inputs:{},level:4 as 1},now);
    expect(legacy.level).toBe(1);expect(legacy.weight).toBe(0);
    expect(upgradeFairValue({...r,calculatedAt:'bad'},now).fairValue).toBeNull();
  });
  it('uses the identical peer enrichment in catalogue and standalone calculation',()=>{
    const stocks=['TEST','A','B','C','D','E'].map(ticker=>({ticker,industry:'Software'}));
    const results=Object.fromEntries(stocks.map(s=>[s.ticker,{valuation:calculateFairValue(data({pe:12,evEbit:10,price:20}),now)}]));
    const peers=peerInputs('TEST','Software',stocks,results,now,'USD');
    const raw=data({eps:5,ebit:100,cash:0,debt:0,shares:10});
    const catalogue=calculateFairValue({...raw,...peers},now);
    const desktop=calculateFairValue({...raw,...peerInputs('TEST','Software',stocks,results,now,'USD')},now);
    expect(desktop).toEqual(catalogue);expect(upgradeFairValue(catalogue,now)).toEqual(catalogue);
    results.A.valuation.currency='EUR';expect(peerInputs('TEST','Software',stocks,results,now,'USD').peerPE).toBeUndefined();
  });
  it('retries cache failures, deduplicates success, expires and invalidates',async()=>{
    let time=0,calls=0;const cache=new AsyncCache<number>(10,2,()=>time);
    const load=async()=>{calls++;return calls;};
    await expect(cache.get('failure',async()=>{throw Error('offline');})).rejects.toThrow();
    expect(await cache.get('failure',load)).toBe(1);
    expect(await Promise.all([cache.get('a',load),cache.get('a',load)])).toEqual([2,2]);
    time=11;expect(await cache.get('a',load)).toBe(3);
    cache.clear();expect(await cache.get('a',load)).toBe(4);
  });
  it('does not refill an invalidated cache from an old in-flight request',async()=>{
    const cache=new AsyncCache<number>(10);let finish!:(n:number)=>void;
    const old=cache.get('a',()=>new Promise<number>(resolve=>{finish=resolve;}));
    await Promise.resolve();cache.clear();finish(1);await old;
    expect(await cache.get('a',async()=>2)).toBe(2);
  });
  it('evicts bounded cache entries',async()=>{
    const cache=new AsyncCache<number>(100,1);
    await cache.get('a',async()=>1);await cache.get('b',async()=>2);
    expect(await cache.get('a',async()=>3)).toBe(3);
  });
  it('handles manual update, errors, retry, download and installation readiness',()=>{
    let s=reduceSoftwareUpdate({status:'idle',version:''},{type:'checking'});
    s=reduceSoftwareUpdate(s,{type:'error',message:'offline'});expect(s.error).toBe('offline');
    s=reduceSoftwareUpdate(s,{type:'checking'});expect(s.error).toBeUndefined();
    s=reduceSoftwareUpdate(s,{type:'available',version:'1.6.7'});
    s=reduceSoftwareUpdate(s,{type:'progress',percent:40});expect(s.progress).toBe(40);
    s=reduceSoftwareUpdate(s,{type:'downloaded',version:'1.6.7'});expect(s.status).toBe('downloaded');
    expect(reduceSoftwareUpdate(s,{type:'current'}).status).toBe('current');
  });
  it('parses exact SEC annual units and rejects mixed accessions and future filings',()=>{
    const fact=(val:number)=>({val,start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',form:'10-K',accn:'same'});
    const facts={cik:1,facts:{'us-gaap':{
      NetCashProvidedByUsedInOperatingActivities:{units:{USD:[fact(100)]}},
      PaymentsToAcquirePropertyPlantAndEquipment:{units:{USD:[fact(20)]}},
      WeightedAverageNumberOfDilutedSharesOutstanding:{units:{shares:[fact(10)]}},
      EarningsPerShareDiluted:{units:{'USD/shares':[{...fact(4),accn:'different'}]}},
    }}};
    const r=parseSecAnnual(facts,'https://data.sec.gov',new Date(now).toISOString());
    expect(r.fcf.value).toBe(80);expect(r.fcfProxyPerShare.value).toBe(8);expect(r.eps).toBeUndefined();
    expect(r.fcf.period).toBe('FY');expect(r.fcf.asOf).toBe('2025-12-31');
    expect(parseSecAnnual(facts,'https://data.sec.gov','2026-01-01')).toEqual({});
  });
  it('keeps offsets and Christmas/July early closes free of look-ahead',()=>{
    expect(earliestEntryDate('2026-01-05T16:00:00-05:00')).toBe('2026-01-06');
    expect(earliestEntryDate('2026-12-24 18:00:00')).toBe('2026-12-25');
    expect(earliestEntryDate('2025-07-03T17:00:00Z')).toBe('2025-07-04');
  });
});
