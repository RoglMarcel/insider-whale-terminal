import { type Fact, type Fundamentals, type ValuationDocument } from './types';
const PROVIDERS: readonly string[] = ['stockrow','tikr','macrotrends'];
const DOMAINS: Record<string,string[]> = {stockrow:['stockrow.com'],gurufocus:['gurufocus.com','www.gurufocus.com'],tikr:['tikr.com','www.tikr.com','app.tikr.com'],macrotrends:['macrotrends.net','www.macrotrends.net']};
const PER_SHARE=new Set(['eps','forwardEps','dividendPerShare','realEps']);
const FRACTIONS=new Set(['taxRate','payoutRatio','expectedEpsGrowth','riskFreeRate','optionVolatility']);
const RATIOS=new Set(['pe','forwardPe','ps','pb','pcf','ptbv','evEbit','evEbitda','evSales','cape','targetForwardPe','targetPs','targetPb','targetPcf','targetPtbv','targetEvEbit','targetEvEbitda','targetEvSales','targetCape','optionYears']);
const CURRENCY=['revenue','netIncome','ebit','ebitda','pretaxIncome','incomeTax','cash','receivables','inventory','ppe','liabilities','bookEquity','totalEquity','debt','operatingCashFlow','depreciation','capex','netBorrowing','dividendsPaid','receivableCashChange','inventoryCashChange','payableCashChange','otherWorkingCashChange','workingCapitalChange','minority','preferred','goodwill','intangibles','totalIntangibles','tangibleEquity','investedCapital','taxShieldPv','distressCostPv','assetMarketValue','liquidationCosts','replacementAssetValue','adjustedNetAssets','weightedAdjustedEarnings','baseEquityValue','optionAsset','optionInvestment','corporateCostPv'];
const KNOWN = new Set([...PER_SHARE,...FRACTIONS,...RATIOS,...CURRENCY,'shares']);
function fact(key:string,input:unknown):Fact|null {
  if(!KNOWN.has(key)||!input||typeof input!=='object')return null;
  const f=input as Fact;
  const expected=key==='shares'?'shares':PER_SHARE.has(key)?'perShare':FRACTIONS.has(key)?'fraction':RATIOS.has(key)?'ratio':'currency';
  if(typeof f.value!=='number'||!Number.isFinite(f.value)||Math.abs(f.value)>1e16||f.unit!==expected||typeof f.period!=='string'||! /^(?:(?:TTM|forecast) observed )?\d{4}-\d{2}(?:-\d{2})?$/.test(f.period))return null;
  return {value:f.value,unit:f.unit,period:f.period,...(f.derived===true?{derived:true}:{})};
}
/** Strict allowlist output also strips all unknown imported fields, including cookies, sessions and tokens. */
export function validateFundamentals(input:unknown,ticker:string):Fundamentals|null {
  if(!input||typeof input!=='object')return null;
  const d=input as Fundamentals;
  if(d.ticker!==ticker||!PROVIDERS.includes(d.provider)||!/^\d{4}-\d{2}(?:-\d{2})?$/.test(d.statementDate)||!Number.isFinite(Date.parse(d.statementDate))||!Number.isFinite(Date.parse(d.fetchedAt))||!['USD','EUR','GBP','CAD','CHF','JPY','AUD','HKD'].includes(d.currency))return null;
  let url:URL;try{url=new URL(d.url);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!DOMAINS[d.provider].includes(url.hostname))return null;
  const facts:Record<string,Fact>={};for(const [key,value]of Object.entries(d.facts??{})){const f=fact(key,value);if(f)facts[key]=f;}
  if(!Object.keys(facts).length)return null;
  const annual:Record<string,Fact[]>={};for(const [key,rows]of Object.entries(d.annual??{})){if(!Array.isArray(rows))continue;const clean=rows.map(row=>fact(key,row)).filter((v):v is Fact=>!!v);if(clean.length)annual[key]=clean.slice(0,30);}
  const result:Fundamentals={ticker,provider:d.provider,url:url.href,fetchedAt:d.fetchedAt,currency:d.currency,statementDate:d.statementDate,facts,annual};
  if(typeof d.price==='number'&&Number.isFinite(d.price)&&d.price>0&&d.priceAsOf&&/^\d{4}-\d{2}-\d{2}$/.test(d.priceAsOf)){result.price=d.price;result.priceAsOf=d.priceAsOf;}
  if(d.basis==='TTM observations; forecast growth excludes non-recurring items')result.basis=d.basis;
  if(typeof d.industry==='string'&&d.industry.length<160)result.industry=d.industry;
  if(Array.isArray(d.peers))result.peers=d.peers.filter(p=>p&&/^[A-Z0-9.\-]{1,12}$/.test(p.ticker)&&!!result.industry&&p.industry===result.industry&&Number.isFinite(p.pe)&&p.pe>0).map(p=>({ticker:p.ticker,industry:p.industry,pe:p.pe})).slice(0,100);
  if(Array.isArray(d.segments))result.segments=d.segments.filter(s=>s&&typeof s.name==='string'&&s.name.length<120&&Number.isFinite(s.ebit)&&Number.isFinite(s.multiple)).map(s=>({name:s.name,ebit:s.ebit,multiple:s.multiple}));
  return result;
}
export function validateDocument(input:unknown):ValuationDocument {
  const d=input as ValuationDocument;
  if(!d||d.schemaVersion!==1||!Number.isFinite(Date.parse(d.generatedAt))||!d.stocks||typeof d.stocks!=='object')throw new Error('Invalid valuation document');
  const stocks:ValuationDocument['stocks']={};
  for(const[ticker,rows]of Object.entries(d.stocks)){if(!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(ticker)||!Array.isArray(rows))continue;stocks[ticker]=rows.map(row=>validateFundamentals(row,ticker)).filter((v):v is Fundamentals=>!!v).slice(0,4);}
  return {schemaVersion:1,generatedAt:d.generatedAt,stocks};
}
