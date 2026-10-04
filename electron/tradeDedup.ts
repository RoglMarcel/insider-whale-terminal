import type { RawInsiderTrade } from '../src/types';
import { normalizeInsiderName, classifyTransaction } from '../src/types';
import { filingAccession } from './filingIdentity';

const rank = (t: RawInsiderTrade) => t.source === 'edgar' ? 0 : t.source === 'openinsider' ? 1 : ['quiverquant','ceowatcher'].includes(t.source) ? 3 : 2;
const close = (a: number, b: number) => Math.abs(a-b) <= Math.max(Math.abs(a),Math.abs(b))*0.05;
const person = (t: RawInsiderTrade) => normalizeInsiderName(t.insiderName);
const sameKind = (a: RawInsiderTrade,b: RawInsiderTrade) => classifyTransaction(a.transactionType).modifier === classifyTransaction(b.transactionType).modifier;

/** Match one observation at a time. Never discard a source's entire person/day group. */
export function dedupTrades(trades: RawInsiderTrade[]): RawInsiderTrade[] {
  const detailed = new Set(trades.filter(t => t.source === 'edgar' && t.filingRow != null).flatMap(t => [filingAccession(t), /^filing:(\d{18}):row:/.exec(t.revisionOf ?? '')?.[1]]));
  const ordered = trades.map(t => ({ ...t })).sort((a,b) => rank(a)-rank(b));
  const kept: RawInsiderTrade[] = [];
  const matchedSources = new Map<RawInsiderTrade, Set<string>>();
  for (const t of ordered) {
    const acc = filingAccession(t);
    // A source's filing aggregate cannot be added to that filing's individual SEC rows.
    if (acc && detailed.has(acc) && !(t.source === 'edgar' && t.filingRow != null)) {
      if (t.insiderUrl) for (const keptRow of kept) {
        const covered = filingAccession(keptRow) === acc || keptRow.revisionOf?.startsWith(`filing:${acc}:row:`);
        if (covered && !keptRow.insiderUrl) keptRow.insiderUrl = t.insiderUrl;
      }
      continue;
    }
    const match = kept.find(k => {
      if (k.ticker !== t.ticker || k.tradeDate !== t.tradeDate || person(k) !== person(t) || !sameKind(k,t)) return false;
      if (k.source === t.source || matchedSources.get(k)?.has(t.source)) return false;
      const ka = filingAccession(k);
      if (acc && ka && acc !== ka) return false;
      return (acc && ka === acc) || (close(k.value,t.value) && (!(k.shares > 0 && t.shares > 0) || close(k.shares,t.shares)));
    });
    if (match) {
      if (!match.insiderUrl) match.insiderUrl = t.insiderUrl;
      const sources = matchedSources.get(match) ?? new Set<string>(); sources.add(t.source); matchedSources.set(match,sources);
      continue;
    }
    // A coarse estimate that cannot be reconciled is retained for audit, withheld from score/volume.
    if (rank(t) === 3 && kept.some(k => rank(k) < 3 && k.ticker === t.ticker && person(k) === person(t) && k.tradeDate === t.tradeDate)) t.integrityStatus = 'ambiguous-overlap';
    kept.push(t);
  }
  return kept;
}
