import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseExternalFairValue, compareExternalFairValues, fetchExternalFairValues, EXTERNAL_PROVIDERS } from '../electron/scraper/externalFairValue';
import { calculateFairValue } from '../electron/fairValue';
import { upgradeFairValue } from '../src/lib/fairValueDisplay';

afterEach(()=>vi.unstubAllGlobals());
const alpha = '<h1>Apple</h1><div>NASDAQ:AAPL</div><p>The intrinsic value for Apple Inc (AAPL) under the Base Case is <b>223.03</b> USD.</p><p>Wall St target $336.6</p>';
describe('external valuation source validation',()=>{
  it('extracts the base value and never substitutes an analyst target',()=>{
    expect(parseExternalFairValue(alpha,'AAPL','alphaspread')).toEqual({value:223.03,currency:'USD'});
    expect(parseExternalFairValue(alpha.replace('Base Case is <b>223.03</b> USD','Bull Case is 400 USD'),'AAPL','alphaspread')).toBeNull();
    expect(parseExternalFairValue(alpha,'AAP','alphaspread')).toBeNull();
  });
  it('rejects values hidden in scripts and accepts the exact GF Value label',()=>{
    expect(parseExternalFairValue('<script>'+alpha+'</script>','AAPL','alphaspread')).toBeNull();
    expect(parseExternalFairValue('<title>AAPL GF Value: $287.61 | GuruFocus</title><h2>GF Value™: $287.61</h2>','AAPL','gurufocus')).toEqual({value:287.61,currency:'USD'});
    expect(parseExternalFairValue('<title>AAPL Stock</title><p>Peter Lynch Fair Value: $180</p>','AAPL','gurufocus')).toBeNull();
    expect(parseExternalFairValue('<title>MSFT Stock</title><p>GF Value: $400</p>','AAPL','gurufocus')).toBeNull();
  });
  it('extracts the exact FVC listing and uses valuation date rather than quote date',()=>{
    const html='<h1>GameStop Corp. (GME) fair value: what the stock is really worth</h1><div>GME · US</div><p>As of Oct 2, 2026: price $24.70</p><p>GameStop Corp. (GME) currently trades at $24.70, while our model-based Fair Value estimate is $11.77, 52.3% below the price.</p><p class="sp-chart-cap" id="sp-chart-cap">As of Sep 27, 2026.</p>';
    expect(parseExternalFairValue(html,'GME','fairvaluecalculator')).toEqual({value:11.77,currency:'USD',asOf:'2026-09-27'});
    expect(parseExternalFairValue(html,'GM','fairvaluecalculator')).toBeNull();
    expect(parseExternalFairValue(html.replace('GME · US','GME · CA'),'GME','fairvaluecalculator')).toBeNull();
    expect(parseExternalFairValue(html.replace('Sep 27, 2026','Sep 27, 2099'),'GME','fairvaluecalculator')).toBeNull();
    expect(parseExternalFairValue(html.replace('$11.77','$0'),'GME','fairvaluecalculator')).toBeNull();
    expect(parseExternalFairValue('<script>'+html+'</script>','GME','fairvaluecalculator')).toBeNull();
  });
  it('removes retired providers from collection and persisted comparisons',()=>{
    expect(EXTERNAL_PROVIDERS).not.toContain('valueinvesting');
    const result=calculateFairValue({});
    const legacy={provider:'valueinvesting' as const,method:'Lynch',url:'https://valueinvesting.io',fetchedAt:result.calculatedAt,currency:'USD',value:100,status:'available' as const};
    expect(compareExternalFairValues(result,[legacy])).toEqual([]);
    expect(upgradeFairValue({...result,externalComparisons:[legacy]}).externalComparisons).toEqual([]);
  });
  it('reports denominator-correct comparisons without changing valuation or scoring',()=>{
    const now=Date.now();const result=calculateFairValue({eps:{value:10,source:'https://example.com',fetchedAt:new Date(now).toISOString()},price:{value:100,source:'https://example.com',fetchedAt:new Date(now).toISOString()}},now);
    const c=compareExternalFairValues(result,[{provider:'alphaspread',method:'Base',url:'https://www.alphaspread.com',fetchedAt:result.calculatedAt,currency:'USD',value:200,status:'available'}])[0];
    expect(c.modelDifferencePct).toBeCloseTo(-37.5);expect(c.marketMispricingPct).toBe(-50);
    expect(result.fairValue).toBe(125);expect(result.level).toBe(1);
    expect(compareExternalFairValues(result,[{...c,currency:'EUR'}])[0].modelDifferencePct).toBeNull();
  });
  it('does not guess a venue or convert currencies when listing verification is missing',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const result=await fetchExternalFairValues('SAP.DE',{price:100,currency:'EUR',asOf:new Date().toISOString(),name:'SAP',exchange:'XETRA',source:'https://example.com'});
    expect(fetch).not.toHaveBeenCalled();expect(result.every(c=>c.status==='unsupported')).toBe(true);
  });
  it('keeps partial success when another provider blocks access',async()=>{
    const html=alpha.replaceAll('AAPL','EXTEST');
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('alphaspread')?new Response(html):new Response('',{status:403})));
    const result=await fetchExternalFairValues('EXTEST',{price:100,currency:'USD',asOf:new Date().toISOString(),name:'Example',exchange:'NasdaqGS',source:'https://example.com'});
    expect(result.find(c=>c.provider==='alphaspread')?.value).toBe(223.03);expect(result.find(c=>c.provider==='gurufocus')?.status).toBe('blocked');
    const second=await fetchExternalFairValues('EXTESTNEXT',{price:100,currency:'USD',asOf:new Date().toISOString(),name:'Example',exchange:'NasdaqGS',source:'https://example.com'});
    const paused=second.find(c=>c.provider==='gurufocus')!;
    expect(paused.status).toBe('cooldown');expect(paused.fetchedAt).toBe('');expect(Date.parse(paused.retryAt!)).toBeGreaterThan(Date.now());
  });
  it('normalizes previously persisted stage 4 to at most 3',()=>{
    const now=Date.now();const v=calculateFairValue({eps:{value:10,source:'https://example.com',fetchedAt:new Date(now).toISOString()}},now);
    const legacy={...v,level:4} as unknown as typeof v;
    expect(upgradeFairValue(legacy).level).toBeLessThanOrEqual(3);
  });
});
