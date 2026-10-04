import type { RawInsiderTrade } from '../src/types';
import { utcDateMs, utcInstantMs } from '../src/lib/utcDate';
import { filingAccession } from './filingIdentity';

const owners = (t: RawInsiderTrade): string | null => {
  const ids = t.reportingOwners?.map(o => o.cik);
  return ids?.length && ids.every(id => /^\d+$/.test(id)) ? [...new Set(ids)].sort().join(',') : null;
};
const slot = (t: RawInsiderTrade) => JSON.stringify([t.tradeDate,t.transactionType,t.securityTitle,t.ownershipNature]);

/** dateOfOriginalSubmission is a date, not an accession. Only unique candidates may link. */
export function linkAmendments(input: RawInsiderTrade[]): RawInsiderTrade[] {
  const out = input.map(t => ({ ...t }));
  for (const amendment of out.filter(t => t.source === 'edgar' && t.amendment)) {
    const ownerKey = owners(amendment);
    if (!ownerKey || !amendment.issuerCik || utcDateMs(amendment.originalSubmissionDate ?? '') === null) continue;
    const candidates = out.filter(t => t.source === 'edgar' && !t.amendment && t.filingRow != null &&
      t.issuerCik === amendment.issuerCik && owners(t) === ownerKey && t.filingDate === amendment.originalSubmissionDate);
    const accessions = new Set(candidates.map(filingAccession));
    // Repeated retrievals do not count as independent candidate transactions.
    const distinct = [...new Map(candidates.map(t => [t.transactionId, t])).values()];
    const matching = distinct.filter(t => slot(t) === slot(amendment));
    const amendmentRows = new Set(out.filter(t => filingAccession(t) === filingAccession(amendment)).map(t => t.transactionId));
    const original = accessions.size === 1 && accessions.has(undefined) === false
      ? (matching.length === 1 ? matching[0] : distinct.length === 1 && amendmentRows.size === 1 ? distinct[0] : undefined)
      : undefined;
    const originalTime = original && utcInstantMs(original.revisionAt);
    const amendedTime = utcInstantMs(amendment.revisionAt);
    if (amendment.filingRow != null && original?.transactionId && originalTime != null && amendedTime != null && amendedTime > originalTime &&
        original.revisionAt?.includes('T') && amendment.revisionAt?.includes('T')) {
      amendment.revisionOf = original.transactionId;
      amendment.integrityStatus = undefined;
    } else {
      // An unresolved correction must not leave a possibly superseded original scoring.
      for (const candidate of candidates) candidate.integrityStatus = 'revision-conflict';
    }
  }
  return out;
}
