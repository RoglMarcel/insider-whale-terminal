import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { peerInputs, type PeerStock } from '../src/lib/valuationPeers';
import type { FundamentalDatum, FairValueResult } from '../src/types/fairValue';
import { calculateFairValue } from './fairValue';
import { AsyncCache } from '../src/lib/asyncCache';
import { scopedFetch } from './scraper/cancellation';
type Universe={stocks:PeerStock[];results:Record<string,{valuation:FairValueResult}>};
const online=new AsyncCache<Universe>(300000,1);
let retryAfter=0;
let cached: { file:string;mtime:number;stocks:PeerStock[];results:Record<string,{valuation:FairValueResult}> } | undefined;
export async function enrichFromCatalogue(ticker:string, inputs:Record<string,FundamentalDatum>, now:number, warnings:string[], currency:string, industry?:string) {
  let universe:Universe|undefined;
  const resources=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
  for (const file of [path.resolve('data/analysis-cache.json.gz'),...(resources?[path.join(resources,'app.asar','dist','data','analysis-cache.json.gz')]:[])]) {
    try {
      const mtime=fs.statSync(file).mtimeMs;
      if (!cached || cached.file!==file || cached.mtime!==mtime) cached={...JSON.parse(gunzipSync(fs.readFileSync(file)).toString()),file,mtime};
      universe=cached;break;
    } catch { /* optional enrichment; preserve usable standalone inputs */ }
  }
  if(process.env.ANALYSIS_CATALOGUE_BUILD!=='1' && retryAfter<=Date.now())try {
    universe=await online.get('published',async()=>{
      const response=await scopedFetch('https://roglmarcel.github.io/insider-whale-web/data/analysis-cache.json.gz',{signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new Error('Shared industry universe unavailable');
      const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>25000000)throw new Error('Catalogue too large');
      const data=JSON.parse(gunzipSync(bytes,{maxOutputLength:100000000}).toString()) as Universe;
      if(!Array.isArray(data.stocks)||!data.results||typeof data.results!=='object')throw new Error('Invalid shared universe');return data;
    });
  } catch {retryAfter=Date.now()+60000;}
  if(universe){
    const sector=industry||universe.stocks.find(s=>s.ticker===ticker)?.industry;
    const peers=peerInputs(ticker,sector,universe.stocks,universe.results,now,currency);
    return calculateFairValue({...inputs,...peers},now,[...warnings,...(Object.keys(peers).length?['Peer comparisons use the shared dated industry universe; derived ratios are not independent fundamental observations.']:['No suitable current industry benchmarks in the shared catalogue.'])],currency);
  }
  return calculateFairValue(inputs,now,[...warnings,'Industry comparison universe unavailable; standalone inputs only.'],currency);
}
