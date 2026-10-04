import type { FundamentalDatum, FairValueResult } from '../types/fairValue';
export interface PeerStock { ticker: string; industry?: string }
export function peerInputs(ticker: string, industry: string | undefined, stocks: PeerStock[], results: Record<string,{valuation:FairValueResult}>, now: number, currency: string) {
  const inputs: Record<string,FundamentalDatum> = {};
  if (!industry) return inputs;
  const peers = stocks.filter(s=>s.ticker!==ticker && s.industry===industry).flatMap(s=>{
    const r=results[s.ticker]?.valuation;
    return r && r.currency===currency && now-Date.parse(r.calculatedAt)>=0 && now-Date.parse(r.calculatedAt)<=86400000 ? [{ticker:s.ticker,valuation:r}] : [];
  });
  for (const [field,target,max] of [['pe','peerPE',100],['forwardPE','peerForwardPE',100],['ps','peerPS',50],['pb','peerPB',50],['pcf','peerPCF',100],['ptbv','peerPTBV',100],['peg','peerPEG',5],['evEbit','peerEVEBIT',100],['evEbitda','peerEVEBITDA',100],['evSales','peerEVSales',50],['dividendYield','peerDividendYield',.15]] as const) {
    const observations=peers.flatMap(p=>{
      const d=p.valuation.inputs?.[field];
      return d && d.value>0 && d.value<max && now-Date.parse(d.fetchedAt)>=0 && now-Date.parse(d.fetchedAt)<=86400000 ? [{ticker:p.ticker,datum:d}] : [];
    });
    if (observations.length<5) continue;
    const values=observations.map(o=>o.datum.value).sort((a,b)=>a-b);
    const oldest=Math.min(...observations.map(o=>Date.parse(o.datum.fetchedAt)));
    inputs[target]={value:(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2,source:'https://stockanalysis.com/stocks/',fetchedAt:new Date(oldest).toISOString(),asOf:null,period:'unknown',origin:'derived',unit:target==='peerDividendYield'?'decimal':'ratio',derivation:`Median of ${field}; industry ${industry}; >=5 other companies; same currency; positive non-extreme ratios`,dependencies:observations.map(o=>`${o.ticker}:${field}@${o.datum.fetchedAt}`)};
  }
  if (/\b(banks?|insurance|credit services)\b/i.test(industry)) inputs.financialCompany={value:1,source:'https://stockanalysis.com/stocks/',fetchedAt:new Date(now).toISOString(),origin:'derived',unit:'flag',period:'unknown',derivation:`Industry classification: ${industry}`};
  return inputs;
}
