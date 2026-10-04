import { MODEL_IDS, DEFAULT_ASSUMPTIONS, type Assumptions, type Fundamentals, type ModelId, type ModelResult } from './types';

const FORMULAS: Record<ModelId, string> = {
  fcff:'(Σ FCFFₜ/(1+WACC)ᵗ + TV/(1+WACC)ⁿ − debt + cash − minority − preferred) / shares',
  fcfe:'(Σ FCFEₜ/(1+Ke)ᵗ + TV/(1+Ke)ⁿ) / shares', ddm:'D₀ × (1+g) / (Ke−g)', ddm2:'Σ Dₜ/(1+Ke)ᵗ + Dₙ×(1+g∞)/(Ke−g∞)/(1+Ke)ⁿ',
  apv:'(PV(unlevered FCFF) + PV(tax shields) − PV(distress costs) − debt + cash − minority − preferred) / shares',
  residual:'(book equity + PV(net incomeₜ − Ke×book equityₜ₋₁)) / shares',
  eva:'(invested capital + PV(NOPATₜ − WACC×invested capitalₜ₋₁) − debt + cash − minority − preferred) / shares',
  peHistory:'EPS × mean(historical P/E)',peIndustry:'EPS × median(industry peer P/E)',forwardPe:'Forward EPS × target forward P/E',peg:'EPS × EPS growth(%) × target PEG',cape:'mean(real EPS, 10y) × target CAPE',
  evEbit:'(EBIT × target EV/EBIT − debt + cash − minority − preferred) / shares',evEbitda:'(EBITDA × target EV/EBITDA − debt + cash − minority − preferred) / shares',
  ps:'Revenue / shares × target P/S',evSales:'(Revenue × target EV/Sales − debt + cash − minority − preferred) / shares',pb:'Book equity / shares × target P/B',pcf:'Operating cash flow / shares × target P/CF',ptbv:'(Book equity − goodwill − other intangibles) / shares × target P/TBV',
  yield:'Annual DPS / market yield',nav:'(Market value of assets − total liabilities − preferred) / shares',liquidation:'(cash + receivables×recovery + inventory×recovery + PPE×recovery − liabilities − costs − preferred) / shares',
  reproduction:'(Replacement cost of assets − liabilities − preferred) / shares',stuttgart:'0.68 × (adjusted net assets + 5 × weighted adjusted earnings) / shares',
  realOption:'(base equity + S×N(d₁) − K×exp(−rT)×N(d₂)) / shares',sotp:'(Σ segment EBIT×segment multiple − PV(corporate costs) − debt + cash − minority − preferred) / shares',
};
class Missing extends Error { constructor(readonly fields: string[]) { super('Missing inputs'); } }
class Invalid extends Error { constructor(readonly fields: string[]) { super('Invalid inputs'); } }
const median = (values: number[]) => { const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2; };
export function presentValue(base:number,rate:number,growth:number,terminalGrowth:number,years:number):number {
  if (!Number.isFinite(base) || rate<=terminalGrowth || rate<=0 || growth<=-1 || terminalGrowth<=-1 || years<1 || years>30 || !Number.isInteger(years)) throw new Invalid(['discountRate','terminalGrowth','growth','years']);
  let pv=0; for(let t=1;t<=years;t++) pv+=base*Math.pow(1+growth,t)/Math.pow(1+rate,t);
  return pv+base*Math.pow(1+growth,years)*(1+terminalGrowth)/(rate-terminalGrowth)/Math.pow(1+rate,years);
}
function normalCdf(x:number):number {
  const sign=x<0?-1:1; const z=Math.abs(x)/Math.sqrt(2);const t=1/(1+.3275911*z);
  const erf=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-z*z);
  return .5*(1+sign*erf);
}
export function realOptionCall(s:number,k:number,r:number,sigma:number,time:number):number {
  if(s<=0||k<=0||sigma<=0||time<=0||![s,k,r,sigma,time].every(Number.isFinite)) throw new Invalid(['optionAsset','optionInvestment','optionVolatility','optionYears']);
  const d1=(Math.log(s/k)+(r+sigma*sigma/2)*time)/(sigma*Math.sqrt(time));
  return s*normalCdf(d1)-k*Math.exp(-r*time)*normalCdf(d1-sigma*Math.sqrt(time));
}
/** All 26 methods are independently evaluated; no invented inputs, implicit peer multiples or averaging of correlated models. */
export function calculateModels(data:Fundamentals,a:Assumptions=DEFAULT_ASSUMPTIONS,asOf=new Date().toISOString()):ModelResult[] {
  return MODEL_IDS.map(id=>{
    const used:string[]=[]; const result:ModelResult={id,status:'missing',formula:FORMULAS[id],missing:[],used};
    const need=(...keys:string[])=> {const missing=keys.filter(k=>!Number.isFinite(data.facts[k]?.value));if(missing.length)throw new Missing(missing);};
    const get=(key:string)=>{
      need(key);
      const core=['shares','eps','dividendPerShare','revenue','netIncome','ebit','ebitda','taxRate','depreciation','capex','workingCapitalChange','debt','cash','minority','preferred','operatingCashFlow','netBorrowing','bookEquity','payoutRatio','investedCapital','goodwill','intangibles','tangibleEquity','liabilities','receivables','inventory','ppe'];
      if(core.includes(key)&&![data.statementDate,`TTM observed ${data.statementDate}`].includes(data.facts[key].period))throw new Invalid([key]);
      used.push(key);return data.facts[key].value;
    };
    const positive=(key:string)=>{const n=get(key);if(n<=0)throw new Invalid([key]);return n;};
    const shares=()=>positive('shares');
    const claims=()=>get('debt')-get('cash')+get('minority')+get('preferred');
    const firm=(ev:number)=>(ev-claims())/shares();
    const history=(key:string,min=3)=>{
      const facts=[...new Map((data.annual?.[key]??[]).filter(x=>Number.isFinite(x.value)&&x.value>0).map(x=>[x.period.slice(0,4),x])).values()].sort((x,y)=>y.period.localeCompare(x.period));
      if(new Set(facts.map(x=>x.period)).size<min)throw new Missing([key+'History']);
      used.push(key+'History');return facts.slice(0,10).reduce((sum,x)=>sum+x.value,0)/facts.slice(0,10).length;
    };
    const target=(key:string)=> data.facts[key]?positive(key):history(key.replace(/^target/,'').replace(/^./,x=>x.toLowerCase()));
    const fcff=()=> {need('ebit','taxRate','depreciation','capex','workingCapitalChange');const tax=get('taxRate');if(tax<0||tax>=1)throw new Invalid(['taxRate']);return get('ebit')*(1-tax)+get('depreciation')-get('capex')-get('workingCapitalChange');};
    const discount=(n:number,r:number)=>presentValue(n,r,a.growth,a.terminalGrowth,a.years);
    try {
      if(!Object.values(a).every(Number.isFinite)||!Number.isInteger(a.years)||a.years<1||a.years>30||a.growth<=-1||a.terminalGrowth<=-1||a.wacc<=0||a.costEquity<=0||a.unleveredRate<=0)throw new Invalid(['assumptions']);
      const age=(Date.parse(asOf)-Date.parse(data.statementDate))/86400000;
      if(!Number.isFinite(age)||age>550||age<0) {result.status='stale';result.missing=['statementDate'];return result;}
      if(!data.currency || !data.ticker)throw new Missing(['currency','ticker']);
      let value:number;
      switch(id) {
        case 'fcff': {const cash=fcff();if(cash<=0)throw new Invalid(['fcff']);value=firm(discount(cash,a.wacc));break;}
        case 'fcfe': {need('operatingCashFlow','capex','netBorrowing');const cash=get('operatingCashFlow')-get('capex')+get('netBorrowing');if(cash<=0)throw new Invalid(['fcfe']);value=discount(cash,a.costEquity)/shares();break;}
        case 'ddm': {if(a.costEquity<=a.terminalGrowth||a.costEquity<=0)throw new Invalid(['costEquity','terminalGrowth']);value=positive('dividendPerShare')*(1+a.terminalGrowth)/(a.costEquity-a.terminalGrowth);break;}
        case 'ddm2': value=discount(positive('dividendPerShare'),a.costEquity);break;
        case 'apv': {need('taxShieldPv','distressCostPv');const cash=fcff();if(cash<=0)throw new Invalid(['fcff']);value=firm(discount(cash,a.unleveredRate)+get('taxShieldPv')-get('distressCostPv'));break;}
        case 'residual': {
          const equity=positive('bookEquity'),income=get('netIncome'),payout=get('payoutRatio');
          if(payout<0||payout>1||a.costEquity<=a.terminalGrowth)throw new Invalid(['payoutRatio','costEquity','terminalGrowth']);
          let book=equity,pv=0,ni=income;
          for(let t=1;t<=a.years;t++){ni*=1+a.growth;pv+=(ni-a.costEquity*book)/Math.pow(1+a.costEquity,t);book+=ni*(1-payout);}
          // Explicit terminal scenario: capitalize next-period residual income at perpetual growth.
          const terminalRi=ni*(1+a.terminalGrowth)-a.costEquity*book;
          pv+=terminalRi/(a.costEquity-a.terminalGrowth)/Math.pow(1+a.costEquity,a.years);
          value=(equity+pv)/shares();break;
        }
        case 'eva': {
          const capital=positive('investedCapital'),nopat=get('ebit')*(1-get('taxRate'));
          // Constant ROIC scenario: invested capital grows with operating profit in both stages.
          let ic=capital,pv=0,operating=nopat;
          for(let t=1;t<=a.years;t++){operating*=1+a.growth;pv+=(operating-a.wacc*ic)/Math.pow(1+a.wacc,t);ic*=1+a.growth;}
          if(a.wacc<=a.terminalGrowth)throw new Invalid(['wacc','terminalGrowth']);
          pv+=(operating*(1+a.terminalGrowth)-a.wacc*ic)/(a.wacc-a.terminalGrowth)/Math.pow(1+a.wacc,a.years);
          value=firm(capital+pv);break;
        }
        case 'peHistory': value=positive('eps')*history('pe');break;
        case 'peIndustry': {if(!data.industry)throw new Missing(['industryPeers']);const peers=[...new Map((data.peers??[]).filter(p=>p.industry===data.industry&&p.ticker!==data.ticker&&p.pe>0&&Number.isFinite(p.pe)).map(p=>[p.ticker,p])).values()];if(peers.length<3)throw new Missing(['industryPeers']);used.push('industryPeers');value=positive('eps')*median(peers.map(p=>p.pe));break;}
        case 'forwardPe': value=positive('forwardEps')*target('targetForwardPe');break;
        case 'peg': {const growth=positive('expectedEpsGrowth');if(a.targetPeg<=0)throw new Invalid(['targetPeg']);value=positive('eps')*growth*100*a.targetPeg;break;}
        case 'cape': {const eps=[...new Map((data.annual?.realEps??[]).map(x=>[x.period.slice(0,4),x])).values()].sort((x,y)=>y.period.localeCompare(x.period));if(eps.length<10)throw new Missing(['realEpsHistory']);const avg=eps.slice(0,10).reduce((s,x)=>s+x.value,0)/10;if(avg<=0)throw new Invalid(['realEpsHistory']);used.push('realEpsHistory');value=avg*target('targetCape');break;}
        case 'evEbit': value=firm(positive('ebit')*target('targetEvEbit'));break;
        case 'evEbitda': value=firm(positive('ebitda')*target('targetEvEbitda'));break;
        case 'ps': value=positive('revenue')/shares()*target('targetPs');break;
        case 'evSales': value=firm(positive('revenue')*target('targetEvSales'));break;
        case 'pb': value=positive('bookEquity')/shares()*target('targetPb');break;
        case 'pcf': value=positive('operatingCashFlow')/shares()*target('targetPcf');break;
        case 'ptbv': {const tangible=data.facts.tangibleEquity ? get('tangibleEquity') : get('bookEquity')-get('goodwill')-get('intangibles');if(tangible<=0)throw new Invalid(['tangibleBook']);value=tangible/shares()*target('targetPtbv');break;}
        case 'yield': {if(a.marketYield<=0)throw new Invalid(['marketYield']);value=positive('dividendPerShare')/a.marketYield;break;}
        case 'nav': value=(get('assetMarketValue')-get('liabilities')-get('preferred'))/shares();break;
        case 'liquidation': {need('cash','receivables','inventory','ppe','liabilities','liquidationCosts','preferred');if([a.receivableRecovery,a.inventoryRecovery,a.ppeRecovery].some(n=>n<0||n>1))throw new Invalid(['recovery']);value=(get('cash')+get('receivables')*a.receivableRecovery+get('inventory')*a.inventoryRecovery+get('ppe')*a.ppeRecovery-get('liabilities')-get('liquidationCosts')-get('preferred'))/shares();break;}
        case 'reproduction': value=(get('replacementAssetValue')-get('liabilities')-get('preferred'))/shares();break;
        case 'stuttgart': value=.68*(get('adjustedNetAssets')+5*get('weightedAdjustedEarnings'))/shares();break;
        case 'realOption': value=(get('baseEquityValue')+realOptionCall(positive('optionAsset'),positive('optionInvestment'),get('riskFreeRate'),positive('optionVolatility'),positive('optionYears')))/shares();break;
        case 'sotp': {if(!data.segments?.length||data.segments.some(s=>!s.name||s.ebit<=0||s.multiple<=0||![s.ebit,s.multiple].every(Number.isFinite)))throw new Missing(['segments']);used.push('segments');value=firm(data.segments.reduce((sum,s)=>sum+s.ebit*s.multiple,0)-get('corporateCostPv'));break;}
      }
      if(!Number.isFinite(value)||value<=0)throw new Invalid(['nonPositiveValue']);
      result.status='available';result.value=value;
      if(data.price!=null&&data.price>0&&data.priceAsOf&&(Date.parse(asOf)-Date.parse(data.priceAsOf))/86400000>=0&&(Date.parse(asOf)-Date.parse(data.priceAsOf))/86400000<=10)result.upsidePct=(value/data.price-1)*100;
    } catch(e) {
      if(e instanceof Missing) {result.status='missing';result.missing=e.fields;}
      else if(e instanceof Invalid) {result.status='invalid';result.missing=e.fields;}
      else throw e;
    }
    result.used=[...new Set(used)];return result;
  });
}
