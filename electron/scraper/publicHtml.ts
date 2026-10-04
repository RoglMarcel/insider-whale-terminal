import { AsyncCache } from '../../src/lib/asyncCache';
import { scopedFetch, checkCancelled } from './cancellation';
import { useScrapling, scraplingHtml } from './scrapling';
const cache=new AsyncCache<string>(300000,200);
const pauses=new Map<string,number>();
let running=0;
const queue:(()=>void)[]=[];
export function clearPublicHtmlCache(){cache.clear();pauses.clear();}
/** Two requests total, cached and deduplicated; provider cooldown on 403/429. */
export async function publicHtml(url:string):Promise<string> {
  return cache.get(url,async()=>{
    const host=new URL(url).hostname;
    if((pauses.get(host)||0)>Date.now())throw new Error(`${host}: cooldown after blocked/rate-limited response`);
    if(running>=2)await new Promise<void>(resolve=>queue.push(resolve));else running++;
    try {
      for(let attempt=0;attempt<2;attempt++) {
        checkCancelled();
        if((pauses.get(host)||0)>Date.now())throw new Error(`${host}: cooldown`);
        try {
          if(useScrapling())return await scraplingHtml(url);
          const response=await scopedFetch(url,{headers:{'User-Agent':'InsiderWhalePublicData/1.0'},signal:AbortSignal.timeout(8000)});
          if(!response.ok)throw Object.assign(new Error(`HTTP ${response.status}`),{status:response.status});
          const html=await response.text();if(html.length>8000000)throw new Error('Page too large');return html;
        } catch(error) {
          checkCancelled();
          const status=(error as {status?:number}).status;
          if(status===403||status===429){pauses.set(host,Date.now()+15*60000);throw new Error(`HTTP ${status}; provider paused for 15 minutes`);}
          if(attempt===0&&status!=null&&status>=500){await new Promise(resolve=>setTimeout(resolve,500));continue;}
          pauses.set(host,Date.now()+60000); // bound repeated transport/redirect failures too
          throw error;
        }
      }
      throw new Error('Public source unavailable');
    } finally {const next=queue.shift();if(next)next();else running--;}
  });
}
