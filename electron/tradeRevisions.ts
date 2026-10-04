import { filingAccession } from './filingIdentity';
import { linkAmendments } from './tradeAmendments';
import { createHash } from 'node:crypto';
import type { RawInsiderTrade } from '../src/types';
import { normalizeInsiderName } from '../src/types';
import { utcInstantMs } from '../src/lib/utcDate';

/** Retrieval timestamps deliberately do not participate in identity or revision order. */
export function tradeFingerprint(t: RawInsiderTrade): string {
  const { observedAt: _observed, dateStatus: _dateStatus, integrityStatus: _integrityStatus, ...data } = t;
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}

export function revisionIdentity(t: RawInsiderTrade): string {
  const accession = /(?:\b(\d{10}-\d{2}-\d{6})\b|\/(\d{18})\/)/.exec(t.sourceUrl ?? '');
  const filing = accession ? (accession[1] || accession[2]).replace(/-/g,'') : null;
  const id = t.revisionOf || t.transactionId || (filing ? `filing:${filing}` : undefined);
  const owner = t.source === 'edgar' && t.reportingOwners?.length && t.reportingOwners.every(o => o.cik)
    ? t.reportingOwners.map(o => o.cik).sort().join(',') : normalizeInsiderName(t.insiderName);
  return JSON.stringify(id ? [t.source,t.ticker,owner,id] :
    [t.source,t.ticker,normalizeInsiderName(t.insiderName),t.transactionType,t.tradeDate,t.shares,t.price,t.value]);
}

/** Collapse only source-identified revisions. Ambiguous conflicting versions remain quarantined. */
export function selectTradeRevisions(trades: RawInsiderTrade[]): RawInsiderTrade[] {
  const detailed = new Set(trades.filter(t => t.source === 'edgar' && t.filingRow != null).map(t => filingAccession(t)));
  trades = trades.filter(t => !(t.source === 'edgar' && t.filingRow == null && filingAccession(t) && detailed.has(filingAccession(t))));
  const groups = new Map<string, RawInsiderTrade[]>();
  const linked = linkAmendments(trades);
  const edges = new Map<string, Set<string>>();
  const scope = (t: RawInsiderTrade, id: string) => JSON.stringify([t.source,t.ticker,id]);
  for (const t of linked) if (t.transactionId && t.revisionOf) {
    const key = scope(t,t.transactionId);
    const targets = edges.get(key) ?? new Set<string>(); targets.add(t.revisionOf); edges.set(key,targets);
  }
  for (const trade of linked) {
    if (trade.revisionOf) {
      let root = trade.revisionOf;
      const seen = new Set<string>(trade.transactionId ? [trade.transactionId] : []);
      while (true) {
        if (seen.has(root)) { trade.integrityStatus = 'revision-conflict'; break; }
        seen.add(root);
        const next = edges.get(scope(trade,root));
        if (!next) break;
        if (next.size !== 1) { trade.integrityStatus = 'revision-conflict'; break; }
        root = [...next][0];
      }
      trade.revisionOf = root;
    }
    const key = revisionIdentity(trade);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.values()].map(group => {
    const unique = [...new Map(group.map(t => [tradeFingerprint(t), t])).values()];
    if (unique.length === 1) return { ...unique[0] };
    const economics = (t: RawInsiderTrade) => JSON.stringify([t.tradeDate,t.transactionType,t.shares,t.price,t.value]);
    if (unique.every(t => economics(t) === economics(unique[0]))) {
      // Enrich equal economic rows without losing a known role or history URL.
      const ranked = [...unique].sort((a,b) => (utcInstantMs(b.revisionAt) ?? 0) - (utcInstantMs(a.revisionAt) ?? 0) || b.role.length-a.role.length);
      const winner = { ...ranked[0] };
      if (!winner.role) winner.role = ranked.find(t => t.role)?.role ?? '';
      winner.insiderUrl ??= ranked.find(t => t.insiderUrl)?.insiderUrl;
      return winner;
    }
    const versions = unique.map(t => ({ t, time: utcInstantMs(t.revisionAt) }));
    // A date-only filing is not a precise revision order within that date.
    if (versions.some(v => v.time === null || !v.t.revisionAt?.includes('T'))) return { ...unique[0], integrityStatus: 'revision-conflict' as const };
    versions.sort((a,b) => b.time! - a.time!);
    const winners = versions.filter(v => v.time === versions[0].time);
    if (winners.some(v => economics(v.t) !== economics(winners[0].t))) return { ...winners[0].t, integrityStatus: 'revision-conflict' as const };
    winners.sort((a,b) => b.t.role.length-a.t.role.length);
    return { ...winners[0].t };
  });
}

