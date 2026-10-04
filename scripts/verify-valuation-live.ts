import fs from 'node:fs';
import { fetchFairValue } from '../electron/scraper/fairValue';
import { parseSecAnnual } from '../electron/scraper/secFundamentals';
import { upgradeFairValue } from '../src/lib/fairValueDisplay';
async function main(){
  const rows=[];
  for(const ticker of ['AAPL','NVDA','PEP','MCD','GME','JPM','SAP.DE']){
    const r=await fetchFairValue(ticker);
    const normalized=upgradeFairValue(r);
    if(r.fairValue!=null&&(!Number.isFinite(r.fairValue)||r.fairValue<=0))throw Error(`${ticker}: invalid fair value`);
    if(normalized.mispricingPct!=null&&Math.abs(normalized.mispricingPct-(normalized.price!/normalized.fairValue!-1)*100)>1e-8)throw Error('Deviation mismatch');
    const row={ticker,at:r.calculatedAt,currency:r.currency,status:r.status,level:r.level,fairValue:r.fairValue,price:r.price,fields:Object.keys(r.inputs),comparisons:r.externalComparisons?.map(c=>({provider:c.provider,status:c.status,value:c.value,asOf:c.asOf,reason:c.reason})),warnings:r.warnings};rows.push(row);console.log(JSON.stringify(row));
  }
  if(process.env.SEC_FIXTURE){const raw=JSON.parse(fs.readFileSync(process.env.SEC_FIXTURE,'utf8'));const facts=parseSecAnnual(raw,'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',new Date().toISOString());if(!facts.fcf||!facts.shares)throw Error('Actual SEC response lacks coherent cashflow/shares');console.log(JSON.stringify({secAnnual:Object.fromEntries(Object.entries(facts).map(([k,d])=>[k,{value:d.value,asOf:d.asOf,period:d.period}]))}));}
  fs.mkdirSync('tmp',{recursive:true});fs.writeFileSync('tmp/valuation-live-verification.json',JSON.stringify({at:new Date().toISOString(),rows},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
