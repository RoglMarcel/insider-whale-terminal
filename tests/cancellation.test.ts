import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import { withTimeout, scopedFetch, checkCancelled, cancellableDelay } from '../electron/scraper/cancellation';
import { withPage } from '../electron/scraper/browser';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('phase cancellation',()=>{
  it('aborts the actual fetch and prevents retries after a timeout',async()=>{
    let aborted=false,completed=false;
    const fetch=vi.fn((_url:unknown,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      init.signal?.addEventListener('abort',()=>{aborted=true;reject(init.signal?.reason);},{once:true});
    }));
    vi.stubGlobal('fetch',fetch);
    const result=await withTimeout(async()=>{try {await scopedFetch('https://example.test');}catch {checkCancelled();} completed=true;return true;},10,false);
    expect(result).toBe(false);expect(aborted).toBe(true);expect(completed).toBe(false);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('closes only the timed-out page while another source succeeds',async()=>{
    let rejectNavigation:(reason:Error)=>void=()=>{};
    const close=vi.fn(async()=>rejectNavigation(new Error('Page closed')));
    const page={goto:()=>new Promise((_resolve,reject)=>{rejectNavigation=reject;}),close};
    const context={newPage:vi.fn(async()=>page)} as unknown as BrowserContext;
    const [slow,fast]=await Promise.all([withTimeout(()=>withPage(context,'https://example.test',async()=>true),10,false),withTimeout(async()=>{await cancellableDelay(2);return true;},100,false)]);
    expect(slow).toBe(false);expect(fast).toBe(true);expect(close).toHaveBeenCalled();
  });
  it('prevents a late enrichment write even if a dependency swallows cancellation',async()=>{
    let changed=false;
    await withTimeout(async()=>{try {await cancellableDelay(100);}catch{} checkCancelled();changed=true;return true;},5,false);
    await new Promise(r=>setTimeout(r,5));expect(changed).toBe(false);
  });
  it('clears successful timers',async()=>{
    vi.useFakeTimers();expect(await withTimeout(async()=>7,100,0)).toBe(7);expect(vi.getTimerCount()).toBe(0);
  });
});
