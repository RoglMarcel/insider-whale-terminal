import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketInstant, upcomingMarketRuns, scheduleRegistration } from '../electron/marketSchedule';
import { DEFAULT_SETTINGS } from '../src/types';
import { buildAdjCloseMap } from '../electron/scraper/insiderHistory';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();});
describe('New York Windows schedule',()=>{
 it.each([['2026-03-06','14:30'],['2026-03-09','13:30'],['2026-10-26','13:30'],['2026-11-02','14:30']])('resolves %s independently of registration/local DST', (day,time)=>expect(marketInstant(day,'09:30').toISOString()).toBe(`${day}T${time}:00.000Z`));
 it('generates future weekday instants below the Windows trigger limit and replenishes after a long shutdown',()=>{
  for(const day of ['2026-03-06','2026-10-23','2027-04-01']){const now=Date.parse(day+'T12:00:00Z');const runs=upcomingMarketRuns(DEFAULT_SETTINGS,now);expect(runs.length).toBeGreaterThan(20);expect(runs.length).toBeLessThanOrEqual(33);expect(runs.every(d=>+d>now&&d.getUTCDay()!==0&&d.getUTCDay()!==6)).toBe(true);expect(scheduleRegistration("C:/User's App/app.exe",runs)).toContain("User''s App");expect(scheduleRegistration('app.exe',runs)).toContain(runs[0].toISOString());}
  expect(upcomingMarketRuns({...DEFAULT_SETTINGS,scheduleEnabled:false})).toEqual([]);
 });
});
it('never mixes raw close, nonpositive prices or future observations into an adjusted series',()=>{
 expect(buildAdjCloseMap({timestamp:[1600000000],indicators:{quote:[{close:[10]}]}})).toEqual({});
 expect(Object.values(buildAdjCloseMap({timestamp:[1600000000,1600100000,4102444800],indicators:{adjclose:[{adjclose:[12,-1,15]}]}}))).toEqual([12]);
});
it('retries a failed benchmark immediately instead of caching an empty success',async()=>{
 const {getBenchmarkMap}=await import('../electron/scraper/insiderHistory');
 const fetch=vi.fn().mockResolvedValueOnce(new Response('down',{status:503})).mockResolvedValueOnce(Response.json({chart:{result:[{timestamp:[1600000000],indicators:{adjclose:[{adjclose:[100]}]}}]}}));vi.stubGlobal('fetch',fetch);
 await expect(getBenchmarkMap()).rejects.toThrow('unavailable');expect(Object.values(await getBenchmarkMap())).toEqual([100]);expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps old signals on a failed web refresh without renewing cache freshness and reports recovery',async()=>{
 vi.useFakeTimers();const {webApi}=await import('../src/lib/webApi');const old=[{ticker:'TEST',score:10}];
 const fetch=vi.fn().mockResolvedValueOnce(Response.json(old)).mockResolvedValueOnce(new Response('down',{status:503})).mockResolvedValueOnce(Response.json([]));vi.stubGlobal('fetch',fetch);
 expect(await webApi.signals.getAll()).toEqual(old);vi.advanceTimersByTime(61000);
 expect(await webApi.signals.getAll()).toEqual(old);expect((await webApi.scraper.getStatus()).error).toContain('503');
 expect(await webApi.signals.getAll()).toEqual([]);expect((await webApi.scraper.getStatus()).error).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(3);
});
