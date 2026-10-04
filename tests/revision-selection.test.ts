import { describe, expect, it } from 'vitest';
import { selectTradeRevisions } from '../electron/tradeRevisions';
import { admissibleTrade } from '../src/lib/tradeEligibility';
import { computeSourceHealth, sourceStatus } from '../src/types';
import { trade } from './helpers';
describe('revision identity and admissibility', () => {
  it('reconciles old filing URLs with newly explicit accession IDs without losing roles', () => {
    const sourceUrl='https://www.sec.gov/Archives/edgar/data/1/000000000126000001/form4.xml';
    const rows=selectTradeRevisions([trade({sourceUrl,role:''}),trade({sourceUrl,transactionId:'filing:000000000126000001',role:'CEO'})]);
    expect(rows).toHaveLength(1); expect(rows[0].role).toBe('CEO');
  });
  it('preserves distinct explicit same-day transactions of equal value', () => {
    expect(selectTradeRevisions([trade({transactionId:'one'}),trade({transactionId:'two'})])).toHaveLength(2);
  });
  it('uses source version order in either arrival order, with explicit revision links', () => {
    const old=trade({transactionId:'one',revisionAt:'2026-09-20T10:00:00Z',value:100000});
    const corrected=trade({transactionId:'amendment',revisionOf:'one',revisionAt:'2026-09-21T10:00:00Z',value:50000});
    for (const rows of [[old,corrected],[corrected,old]]) expect(selectTradeRevisions(rows)[0].value).toBe(50000);
  });
  it('does not manufacture order from equal or date-only source versions', () => {
    for(const revisionAt of ['2026-09-20','2026-09-20T10:00:00Z']) {
      const rows=selectTradeRevisions([trade({transactionId:'one',revisionAt,value:100000}),trade({transactionId:'one',revisionAt,value:50000})]);
      expect(rows[0].integrityStatus).toBe('revision-conflict'); expect(admissibleTrade(rows[0])).toBe(false);
    }
  });
  it('does not turn an unlinked amendment into a second scored trade', () => {
    expect(admissibleTrade(trade({integrityStatus:'unlinked-amendment'}))).toBe(false);
  });
  it('does not make later observations available to earlier evaluations', () => {
    expect(admissibleTrade(trade({tradeDate:'2026-09-20',observedAt:'2026-09-22T10:00:00Z'}),undefined,Date.parse('2026-09-21T12:00:00Z'))).toBe(false);
  });
});
describe('source status persistence', () => {
  it('does not forget a dead source when additional zeros lower its median', () => {
    const counts=[0,0,0,0,10,10];
    const issue=computeSourceHealth(['x'],counts.map(x=>({x})))[0];
    expect(sourceStatus(issue,counts)).toBe('dead');
    expect(sourceStatus(undefined,[0,0,0,0])).toBe('unknown');
  });
});
