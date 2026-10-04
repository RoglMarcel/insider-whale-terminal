import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateFairValue, fadingCashFlow, realOptionCall } from '../electron/fairValue';
import { fetchMarketQuote, fundamentalsLocation, yahooSymbol, searchStocks } from '../electron/marketData';
import { parseStockDirectory, searchCatalogue } from '../electron/analysisCatalogue';
import { analysisMoney, compactNumber } from '../src/lib/analysisFormat';
afterEach(()=>vi.unstubAllGlobals());
const now = Date.now();
const data = (values: Record<string, number>) => Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,source:'https://example.com',fetchedAt:new Date(now).toISOString()}]));
describe('valuation v2 regression',()=>{
  it('does not crush sourced growth to 3%, and discloses the proxy ceiling',()=>{
    const r=calculateFairValue(data({normalizedFcfePerShare:5.26,epsGrowth:.64,revenueGrowth:.6061,price:233.95,eps:7.91}),now);
    expect(r.scenarios?.[1].growth).toBe(.25);
    expect(r.fairValue).toBeCloseTo(fadingCashFlow(5.26,.25,.1,.025));
    expect(r.assumptions.join(' ')).toContain('policy cap 25%');
    expect(r.scenarios![0].value).toBeLessThan(r.fairValue!);
    expect(r.scenarios![2].value).toBeGreaterThan(r.fairValue!);
    expect(r.entryPrice).toBeCloseTo(r.fairValue!*(1-r.marginOfSafety));
  });
  it('does not perpetuate debt issuance or repayment in the normalized cashflow',()=>{
    const a=calculateFairValue(data({normalizedFcfePerShare:10,fcfePerShare:30,epsGrowth:.1}),now);
    const b=calculateFairValue(data({normalizedFcfePerShare:10,fcfePerShare:1,epsGrowth:.1}),now);
    expect(a.fairValue).toEqual(b.fairValue);
  });
  it('does not use token dividends as total equity value',()=>{
    const r=calculateFairValue(data({eps:8,dividend:.04,price:200}),now);
    expect(r.models.find(m=>m.name==='DDM/Gordon Growth')?.value).toBeNull();
  });
  it('matches a constant-growth perpetuity when fade endpoints coincide',()=>{
    expect(fadingCashFlow(10,.02,.1,.02)).toBeCloseTo(10*1.02/(.1-.02));
    expect(fadingCashFlow(10,.1,.02,.025)).toBeNaN();
  });
  it('matches the standard Black-Scholes call benchmark',()=>{
    expect(realOptionCall(100,100,1,.05,.2)).toBeCloseTo(10.4506,3);
  });
  it('excludes industrial cashflow models for financial companies',()=>{
    const r=calculateFairValue(data({financialCompany:1,normalizedFcfePerShare:100,eps:8,price:150}),now);
    expect(r.models.find(m=>m.name==='DCF-FCFE')?.value).toBeNull();
    expect(r.status).toBe('fallback');
    expect(r.fairValue).toBe(100);
  });
});
describe('global quotes and directories',()=>{
  it('preserves foreign suffixes and maps US share classes',()=>{
    expect(yahooSymbol('BRK.B')).toBe('BRK-B');
    expect(yahooSymbol('SAP.DE')).toBe('SAP.DE');
    expect(fundamentalsLocation('SAP.DE')?.url).toContain('/quote/etr/SAP/');
    expect(fundamentalsLocation('7203.T')?.url).toContain('/quote/tyo/7203/');
    expect(fundamentalsLocation('BNS.TO')?.url).toContain('/quote/tsx/BNS/');
    expect(yahooSymbol('VOLV.B.ST')).toBe('VOLV-B.ST');
    expect(fundamentalsLocation('VOLV-B.ST')?.url).toContain('/quote/sto/VOLV.B/');
  });
  it('reads actual quotes and normalizes pence to pounds',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({chart:{result:[{meta:{symbol:'SHEL.L',instrumentType:'EQUITY',currency:'GBp',regularMarketPrice:2500,regularMarketTime:1700000000,fullExchangeName:'LSE'}}]}}))));
    const quote=await fetchMarketQuote('SHEL.L');
    expect(quote?.price).toBe(25);expect(quote?.currency).toBe('GBP');
    expect(quote?.asOf).toBe(new Date(1700000000000).toISOString());
  });
  it('filters non-equity and OTC suggestions',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({quotes:[{symbol:'AAPL',quoteType:'EQUITY',exchange:'NMS',shortname:'Apple'},{symbol:'AAPL=F',quoteType:'FUTURE'},{symbol:'PINK',quoteType:'EQUITY',exchange:'PNK'}]}))));
    expect((await searchStocks('apple-fixture')).map(s=>s.ticker)).toEqual(['AAPL']);
  });
  it('parses directory literals without executing scripts and excludes microcaps',()=>{
    const html='{s:"AAPL",n:"Apple Inc.",industry:"Hardware",marketCap:3000000000000},{s:"TINY",n:"Small",marketCap:10000},{no:1,s:"etr/SAP",n:"SAP SE",marketCap:10000000000,price:100}';
    expect(parseStockDirectory(html).map(s=>s.ticker)).toEqual(['AAPL','SAP']);
    expect(parseStockDirectory(html,'.DE','XETRA').some(s=>s.ticker==='SAP.DE')).toBe(true);
    expect(searchCatalogue(parseStockDirectory(html),'apple')[0].ticker).toBe('AAPL');
  });
  it('formats international compact units without losing signs',()=>{
    expect(compactNumber(127010000000)).toBe('127.01B');
    expect(compactNumber(-1.2e12)).toBe('-1.2T');
    expect(analysisMoney(8.7e9,'EUR','en-US',true)).toBe('8.7B EUR');
  });
});
