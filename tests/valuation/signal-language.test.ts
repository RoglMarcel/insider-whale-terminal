import {expect,it} from 'vitest';
import {localizeScoreNote,localizeRole,localizeTransactionLabel} from '../../src/lib/signal-language';
it('translates recorded financial explanations without changing their numbers',()=>{
 for(const [input,output]of [
  ['5 insiders buying (cluster ×3)','5 Insider kaufen (Cluster ×3)'],
  ['Insider buys ≈ 0.61% of market cap','Insider-Käufe ≈ 0.61% der Marktkapitalisierung'],
  ['Insider signal age decay ×0.82','Altersabschlag des Insider-Signals ×0.82'],
  ['⚡ Legacy flat-bonus score (shadow): 76.7','Vergleichsscore des früheren Modells: 76.7'],
 ])expect(localizeScoreNote(input,'de')).toBe(output);
 expect(localizeScoreNote('Bullish options flow (+12 pts)','en')).toBe('Bullish options flow (+12 pts)');
 expect(localizeRole('President, CEO and Chairman, Dir','de')).toBe('Präsident, CEO und Vorsitzender, Dir');
});

it('translates transaction labels without losing unresolved source types', () => {
 expect(localizeTransactionLabel('Open Market Buy', 'de')).toBe('Kauf am offenen Markt');
 expect(localizeTransactionLabel('Unknown (X)', 'de')).toBe('Unbekannt (X)');
 expect(localizeTransactionLabel('10b5-1 Sale', 'en')).toBe('10b5-1 Sale');
});
