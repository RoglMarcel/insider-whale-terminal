import type { FundamentalDatum } from '../../src/types/fairValue';
import { AsyncCache } from '../../src/lib/asyncCache';
import { fundamentalUnit } from '../../src/lib/fundamentalValidation';
import { scopedFetch, checkCancelled } from './cancellation';
import { createRequestPacer } from './reliability';
interface SecFact { val:number;start?:string;end:string;filed:string;form:string;accn:string }
interface CompanyFacts { cik:number;facts:Record<string,Record<string,{units:Record<string,SecFact[]>}>> }
const cache=new AsyncCache<unknown>(86400000,100);
const pace=createRequestPacer(500);
let pausedUntil=0;
async function json(url:string) {
  return cache.get(url,async()=>{
    await pace();checkCancelled();
    if(pausedUntil>Date.now())throw new Error('SEC source cooldown');
    const r=await scopedFetch(url,{headers:{'User-Agent':'InsiderWhalePublicData/1.0'},signal:AbortSignal.timeout(6000)});
    if(!r.ok){if(r.status===403||r.status===429)pausedUntil=Date.now()+900000;throw new Error(`SEC HTTP ${r.status}`);}
    return r.json();
  });
}
/** Exact annual context and accession; never mix a later comparative with the original filing. */
export function parseSecAnnual(document:CompanyFacts,source:string,fetchedAt:string):Record<string,FundamentalDatum> {
  const now=Date.parse(fetchedAt),gaap=document.facts?.['us-gaap'];
  if(!gaap)return {};
  const cash=gaap.NetCashProvidedByUsedInOperatingActivities?.units.USD || [];
  const annual=cash.filter(f=>f.form==='10-K'&&Number.isFinite(f.val)&&f.start&&Date.parse(f.filed)<=now&&Date.parse(f.end)<=now&&(Date.parse(f.end)-Date.parse(f.start))/86400000>=330&&(Date.parse(f.end)-Date.parse(f.start))/86400000<=400&&now-Date.parse(f.end)<=550*86400000).sort((a,b)=>b.end.localeCompare(a.end)||b.filed.localeCompare(a.filed))[0];
  if(!annual)return {};
  const out:Record<string,FundamentalDatum>={};
  const mappings:Record<string,[string[],string]>={
    operatingCash:[['NetCashProvidedByUsedInOperatingActivities'],'USD'],capex:[['PaymentsToAcquirePropertyPlantAndEquipment'],'USD'],
    eps:[['EarningsPerShareDiluted'],'USD/shares'],shares:[['WeightedAverageNumberOfDilutedSharesOutstanding'],'shares'],
    revenue:[['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'],'USD'],
    cash:[['CashAndCashEquivalentsAtCarryingValue'],'USD'],bookEquity:[['StockholdersEquity'],'USD'],
    dividend:[['CommonStockDividendsPerShareDeclared'],'USD/shares'],
  };
  for(const [key,[tags,unit]] of Object.entries(mappings)) {
    const instant=['cash','bookEquity'].includes(key);
    const facts=tags.flatMap(t=>gaap[t]?.units[unit]||[]);
    const f=facts.find(f=>f.accn===annual.accn&&f.end===annual.end&&(instant?!f.start:f.start===annual.start)&&Number.isFinite(f.val));
    if(f)out[key]={value:f.val,source,fetchedAt,asOf:f.end,period:'FY',currency:unit==='shares'?undefined:'USD',unit:fundamentalUnit(key),origin:'reported',originalValue:String(f.val),derivation:`SEC XBRL annual ${annual.start}..${annual.end}; accession ${annual.accn}; filed ${annual.filed}`};
  }
  if(out.operatingCash&&out.capex)out.fcf={...out.operatingCash,value:out.operatingCash.value-out.capex.value,origin:'derived',dependencies:['operatingCash','capex'],derivation:'Annual operating cash flow - purchases of property, plant and equipment'};
  if(out.shares?.value>0)for(const [key,base] of [['fcfProxyPerShare','fcf'],['bookPerShare','bookEquity'],['salesPerShare','revenue']] as const)if(out[base])out[key]={...out[base],value:out[base].value/out.shares.value,unit:'currency/share',origin:'derived',dependencies:[base,'shares'],derivation:`${base} / annual weighted diluted shares; annual proxy, not normalized history`};
  return out;
}
export async function fetchSecAnnual(ticker:string):Promise<Record<string,FundamentalDatum>> {
  const directory=await json('https://www.sec.gov/files/company_tickers.json') as Record<string,{ticker:string;cik_str:number}>;
  const company=Object.values(directory).find(s=>s.ticker===ticker.replace('.','-'));
  if(!company)return {};
  const source=`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(company.cik_str).padStart(10,'0')}.json`;
  const document=await json(source) as CompanyFacts;
  if(document.cik!==company.cik_str)throw new Error('SEC entity mismatch');
  return parseSecAnnual(document,source,new Date().toISOString());
}
