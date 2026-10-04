import { describe, expect, it } from 'vitest';
import { mapOwnershipDocument } from '../electron/scraper/edgar';
import { selectTradeRevisions } from '../electron/tradeRevisions';
import { dedupTrades } from '../electron/tradeDedup';
import { trade } from './helpers';
import { admissibleTrade } from '../src/lib/tradeEligibility';
import { mapBffTrade, toYmd } from '../electron/scraper/capitoltrades';

const owner = (cik: string, name: string) => ({reportingOwnerId:{rptOwnerCik:cik,rptOwnerName:name},reportingOwnerRelationship:{isDirector:'1'}});
const tx = (date: string, shares=10) => ({transactionDate:{value:date},securityTitle:{value:'Common'},ownershipNature:{directOrIndirectOwnership:{value:'D'}},transactionCoding:{transactionCode:'P'},transactionAmounts:{transactionShares:{value:String(shares)},transactionPricePerShare:{value:'100'},transactionAcquiredDisposedCode:{value:'A'}}});
const map = (accession: string, transactions=[tx('2026-09-01')], amendment=false, owners=[owner('1','Jane Doe')]) => mapOwnershipDocument({ownershipDocument:{documentType:amendment?'4/A':'4',dateOfOriginalSubmission:amendment?'2026-09-02':undefined,issuer:{issuerCik:'99',issuerTradingSymbol:'TEST'},reportingOwner:owners,nonDerivativeTable:{nonDerivativeTransaction:transactions}}}, {cik:'99',accession,indexUrl:`https://www.sec.gov/Archives/edgar/data/99/${accession.replace(/-/g,'')}/form4.xml`,filingDate:amendment?'2026-09-03':'2026-09-02',revisionAt:amendment?'2026-09-03T12:00:00Z':'2026-09-02T12:00:00Z'});
const original='0000000099-26-000001', amended='0000000099-26-000002';

describe('transaction integrity', () => {
  it('keeps separate trade dates and every joint owner without multiplying dollars', () => {
    const rows=map(original,[tx('2026-09-01'),tx('2026-09-02',20)],false,[owner('1','Jane'),owner('2','John')]);
    expect(rows.map(t=>t.tradeDate)).toEqual(['2026-09-01','2026-09-02']);
    expect(rows.reduce((s,t)=>s+t.value,0)).toBe(3000);
    expect(rows[0].reportingOwners).toHaveLength(2);
    expect(new Set(rows.map(t=>t.transactionId)).size).toBe(2);
  });
  it('maps a unique amended row downward and ignores later retrieval of the original', () => {
    const first=map(original), second=map(amended,[tx('2026-09-01',5)],true);
    const selected=selectTradeRevisions([...second,...first,...first]);
    expect(selected).toHaveLength(1); expect(selected[0].value).toBe(500);
    expect(selected[0].integrityStatus).toBeUndefined();
  });
  it('does not infer an amendment target when two original accessions share the filing date', () => {
    const rows=selectTradeRevisions([...map(original),...map('0000000099-26-000003'),...map(amended,[tx('2026-09-01',5)],true)]);
    expect(rows.every(t=>!!t.integrityStatus)).toBe(true);
  });
  it('does not map ambiguous same-day rows by their position in the XML', () => {
    const rows=selectTradeRevisions([...map(original,[tx('2026-09-01'),tx('2026-09-01',20)]),...map(amended,[tx('2026-09-01',5)],true)]);
    expect(rows.every(t=>!!t.integrityStatus)).toBe(true);
  });
  it('supersedes the legacy filing aggregate when detailed rows arrive', () => {
    const detailed=map(original,[tx('2026-09-01'),tx('2026-09-02')]);
    const legacy={...detailed[0],filingRow:undefined,transactionId:`filing:${original.replace(/-/g,'')}`,value:2000};
    expect(selectTradeRevisions([legacy,...detailed])).toHaveLength(2);
  });
  it('preserves distinct same-source/same-amount trades and reconciles other sources one-to-one', () => {
    const rows=[trade({transactionId:'one'}),trade({transactionId:'two'}),trade({source:'finviz'}),trade({source:'finviz'})];
    expect(dedupTrades(rows)).toHaveLength(2);
  });
  it('keeps distinct filings and partial source coverage without changing input amounts', () => {
    const rows=[...map(original),trade({value:4000,shares:40,sourceUrl:'https://www.sec.gov/Archives/edgar/data/99/000000009926000009/form.xml'})];
    const copy=JSON.stringify(rows);
    expect(dedupTrades(rows)).toHaveLength(2); expect(JSON.stringify(rows)).toBe(copy);
  });
  it('does not add another source aggregate to the detailed rows of a joint filing', () => {
    const detailed=map(original,[tx('2026-09-01'),tx('2026-09-02')],false,[owner('1','Jane'),owner('2','John')]);
    const aggregated=trade({sourceUrl:detailed[0].sourceUrl,value:2000});
    expect(dedupTrades([...detailed,aggregated]).reduce((s,t)=>s+t.value,0)).toBe(2000);
  });
  it('withholds conflicting estimates without altering a known exact amount', () => {
    const rows=dedupTrades([trade(),trade({source:'quiverquant',value:70000})]);
    expect(rows.filter(t=>admissibleTrade(t)).reduce((s,t)=>s+t.value,0)).toBe(10000);
  });
});
describe('Congress event dates', () => {
  it('keeps a missing disclosure date unknown', () => {
    const row=mapBffTrade({politicianName:'Jane Doe',chamber:'House',ticker:'TEST',txType:'buy',txDate:'2026-09-01',sizeRangeLow:1000,sizeRangeHigh:15000},'2026-09-27T12:00:00Z');
    expect(row?.tradeDate).toBe('2026-09-01');expect(row?.disclosureDate).toBe('');expect(row?.daysToDisclose).toBeNull();
  });
  it('rejects rolled-over dates and yearless date inference', () => {
    expect(toYmd('2026-02-30')).toBe('');expect(toYmd('02/30/2026')).toBe('');expect(toYmd('Sep 1')).toBe('');
    expect(toYmd('09/01/2026')).toBe('2026-09-01');
  });
});

it('does not resurrect another source version of the original after an amendment',()=>{
  const originalRows=map(original), amendmentRows=map(amended,[tx('2026-09-01',5)],true);
  const duplicate=trade({sourceUrl:originalRows[0].sourceUrl,tradeDate:'2026-09-01',value:1000,shares:10});
  const rows=dedupTrades(selectTradeRevisions([...originalRows,...amendmentRows,duplicate]));
  expect(rows.reduce((s,t)=>s+t.value,0)).toBe(500);
});
it('keeps metadata-only amendments so the original cannot silently remain verified',()=>{
  const rows=selectTradeRevisions([...map(original),...map(amended,[],true)]);
  expect(rows).toHaveLength(2);expect(rows.every(t=>!!t.integrityStatus)).toBe(true);
});
it('resolves explicit multi-hop revision links',()=>{
  const rows=selectTradeRevisions([trade({transactionId:'a',revisionAt:'2026-09-01T00:00:00Z'}),trade({transactionId:'b',revisionOf:'a',value:5000,revisionAt:'2026-09-02T00:00:00Z'}),trade({transactionId:'c',revisionOf:'b',value:2000,revisionAt:'2026-09-03T00:00:00Z'})]);
  expect(rows).toHaveLength(1);expect(rows[0].value).toBe(2000);
});
