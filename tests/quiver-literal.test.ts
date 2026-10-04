import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseQuiverData } from '../electron/scraper/quiverData';
import { scrapeQuiverCongressEmbed } from '../electron/scraper/capitoltrades';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('untrusted Quiver embed', () => {
  it.each(['[(globalThis.__quiverExecuted=true)]','[(()=>{globalThis.__quiverExecuted=true;return 1})()]','[...([])]','[{get a(){globalThis.__quiverExecuted=true}}]','[].map(()=>1)','[1,,2]'])('rejects executable/non-data syntax: %s', async literal => {
    vi.stubGlobal('__quiverExecuted', false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`let recentTradesData=${literal};`)));
    await expect(scrapeQuiverCongressEmbed()).rejects.toThrow();
    expect((globalThis as typeof globalThis & { __quiverExecuted: boolean }).__quiverExecuted).toBe(false);
  });
  it('preserves legitimate values and embedded delimiters through the real mapper', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
    const html = `const recentTradesData = [['ABC',"O'Brien ]; Corp",'Stock','Purchase','$15,001 - $50,000',"O'Brien",'House','Democrat','2026-09-26','2026-09-25',null,true,],];`;
    expect(parseQuiverData(html)[0]).toEqual(['ABC',"O'Brien ]; Corp",'Stock','Purchase','$15,001 - $50,000',"O'Brien",'House','Democrat','2026-09-26','2026-09-25',null,true]);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(html)));
    expect((await scrapeQuiverCongressEmbed())[0].politician).toBe("O'Brien");
  });
  it('supports escaped strings and fails closed on missing/empty data', async () => {
    expect(parseQuiverData(String.raw`var recentTradesData=['O\'Brien','\u0041','\x42',-1.2e3];`)).toEqual(["O'Brien",'A','B',-1200]);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('let recentTradesData=[];')));
    await expect(scrapeQuiverCongressEmbed()).rejects.toThrow('empty');
    expect(() => parseQuiverData('<html>blocked</html>')).toThrow('not found');
  });
});
