import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import { scrapeOpenInsiderSales } from '../electron/scraper/sellside';
import { ymd } from './helpers';
const table=(value: string)=>({headers:['Ticker','Trade Type','Trade Date','Value'],rows:[['TEST','S - Sale',ymd(),value]]});
function context(tables: ReturnType<typeof table>[]): BrowserContext {
  let next=0;
  const empty={headers:['Ticker','Trade Type','Trade Date','Value'],rows:[]};
  const pages=tables.flatMap(t=>t.rows.length?[t,empty]:[t]);
  return {newPage: async()=>({goto:async()=>({ok:()=>true}),close:async()=>{},waitForSelector:async()=>{},evaluate:async()=>pages[next++ % pages.length]})} as unknown as BrowserContext;
}
describe('sell-flow replacement coverage',()=>{
  it('accepts two identical full traversals',async()=>{
    const result=await scrapeOpenInsiderSales(context([table('$50,000')]),vi.fn());
    expect(result.complete).toBe(true);expect(result.rows[0].sellValue).toBe(50000);
  });
  it('withholds an unstable source snapshot',async()=>{
    const issue=vi.fn();const result=await scrapeOpenInsiderSales(context([table('$100,000'),table('$50,000')]),issue);
    expect(result.complete).toBe(false);expect(result.rows).toEqual([]);expect(issue).toHaveBeenCalledWith(expect.stringContaining('changed'));
  });
  it('does not turn malformed rows or missing columns into authoritative zeros',async()=>{
    const invalid=table('not a price');expect((await scrapeOpenInsiderSales(context([invalid]),vi.fn())).complete).toBe(false);
    expect((await scrapeOpenInsiderSales(context([{headers:['Ticker'],rows:[]}]),vi.fn())).complete).toBe(false);
  });
  it('accepts a recognized stable empty result',async()=>{
    const empty=table('$1');empty.rows=[];const result=await scrapeOpenInsiderSales(context([empty]),vi.fn());
    expect(result.complete).toBe(true);expect(result.rows).toEqual([]);
  });
});

it('does not treat a short page as proof that the feed ended',async()=>{
  let calls=0;
  const ctx={newPage:async()=>({goto:async()=>({ok:()=>true}),close:async()=>{},waitForSelector:async()=>{},evaluate:async()=>{calls++;return table('$50,000');}})} as unknown as BrowserContext;
  const result=await scrapeOpenInsiderSales(ctx,vi.fn());
  expect(result.complete).toBe(false);expect(calls).toBe(2);
});
