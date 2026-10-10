import { useEffect,useState } from 'react';
import { api, isWeb } from '@/lib/ipc';
import { useStore } from '@/store/useStore';
import type { FairValueResult } from '@/types/fairValue';
import { upgradeFairValue } from '@/lib/fairValueDisplay';
import { AsyncCache } from '@/lib/asyncCache';
const full=new AsyncCache<FairValueResult>(v=>v.status==='unavailable'?60000:300000,100);
const summaries=new AsyncCache<Record<string,FairValueResult>>(60000,1);
let generation:string|null|undefined;
let running=0;
const queue:(()=>void)[]=[];
export function invalidateAlertFairValues(){full.clear();summaries.clear();}
async function summary(){
  if(!isWeb)return {}; // Desktop cards use saved evidence; full analysis is explicit.
  return summaries.get('all',async()=>{
    const r=await fetch(`${import.meta.env.BASE_URL}data/analysis-summary.json`,{cache:'no-cache',signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw new Error('Summary unavailable');
    const d=await r.json();if(!d.stocks||typeof d.stocks!=='object'||Array.isArray(d.stocks))throw new Error('Invalid summary');
    return Object.fromEntries(Object.entries(d.stocks).filter(([t,v])=>/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(t)&&v&&typeof v==='object')) as Record<string,FairValueResult>;
  });
}
async function retrieve(ticker:string){
  return full.get(ticker,async()=>{
    if(running>=2)await new Promise<void>(resolve=>queue.push(resolve));else running++;
    try{return upgradeFairValue((await api.analysis.analyze(ticker)).valuation);}
    finally{const next=queue.shift();if(next)next();else running--;}
  });
}
export function useAlertFairValue(ticker:string,recorded?:FairValueResult,details=false){
  const updatedAt=useStore(s=>s.lastScrapeAt);
  const [value,setValue]=useState<FairValueResult|undefined>(()=>recorded&&upgradeFairValue(recorded));
  const [loading,setLoading]=useState(false);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(n=>n+1),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    let active=true;
    if(generation!==updatedAt){generation=updatedAt;invalidateAlertFairValues();}
    if(!ticker){setValue(undefined);setLoading(false);return;}
    setValue(recorded&&upgradeFairValue(recorded));setLoading(true);
    void(async()=>{
      let snapshot:FairValueResult|undefined;
      try{snapshot=(await summary())[ticker];}catch{/* full route stays retryable */}
      const newer=(v:FairValueResult)=>!recorded?.fairValue||Date.parse(v.calculatedAt)>=Date.parse(recorded.calculatedAt);
      if(active&&snapshot?.fairValue!=null&&newer(snapshot))setValue(upgradeFairValue(snapshot));
      if(details&&active){
        try{const fetched=await retrieve(ticker);if(active&&(fetched.fairValue!=null||!snapshot)&&newer(fetched))setValue(upgradeFairValue(fetched));}catch{/* preserve explained recorded data */}
      }
      if(active)setLoading(false);
    })();
    return()=>{active=false;};
  },[ticker,recorded,details,updatedAt,refresh]);
  return {value,loading};
}
