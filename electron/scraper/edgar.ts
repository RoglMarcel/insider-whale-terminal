import { scopedFetch } from './cancellation';
import type { BrowserContext } from 'playwright';
import { utcInstantMs } from '../../src/lib/utcDate';
import { XMLParser } from 'fast-xml-parser';
import type { RawInsiderTrade } from '../../src/types';
import { createRequestPacer, retryTransient, SourceHttpError } from './reliability';
import { cleanText, isValidTicker, canonicalTicker } from './util';

/**
 * SEC EDGAR — Form 4 straight from the authoritative source. Discovery via the
 * "current events" Atom feed (most recent Form 4 filings), then each filing's
 * primary XML document is parsed for structured roles, exact share/price
 * values, and the 10b5-1 plan checkbox — no aggregator HTML involved, so this
 * source is immune to the redesign/reformat breakages the scraped sites have.
 *
 * SEC fair-use etiquette: descriptive User-Agent with a contact address and
 * ≤ 10 requests/second (throttled well under that below).
 */

const ATOM_URL =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=only&count=100&output=atom';
const SEC_UA = 'insider-whale-terminal/1.0 (marcel.rogls@gmail.com)';
const FILING_LIMIT = 60;
const CONCURRENCY = 4;
const TOTAL_BUDGET_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const pace = createRequestPacer(300); // one shared queue for all EDGAR workers
const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

type ReadSec = (url: string) => Promise<string>;
function createSecReader(deadline: number): ReadSec {
  let blocked: Error | null = null;
  return (url) => retryTransient(async () => {
    await pace();
    if (blocked) throw blocked;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('EDGAR request budget exhausted');
    const res = await scopedFetch(url, {
      headers: { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining)),
    });
    if (!res.ok) {
      const error = new SourceHttpError(res.status, res.headers.get('retry-after'));
      await res.body?.cancel();
      // Stop the whole source on an access denial or rate limit. Waiting for
      // the next scrape is safer than each worker hammering the same block.
      if (res.status === 403 || res.status === 429) blocked = error;
      throw error;
    }
    return res.text();
  });
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function isTrue(v: unknown): boolean {
  return v === '1' || v === 'true' || v === 1 || v === true;
}

/** Form 4 XML wraps scalars: <transactionShares><value>50000</value></transactionShares>. */
function numVal(node: any): number | undefined {
  const raw = node?.value ?? node;
  if (raw == null || typeof raw === 'object') return undefined;
  const n = parseFloat(String(raw));
  return Number.isFinite(n) ? n : undefined;
}

function strVal(node: any): string {
  const raw = node?.value ?? node;
  return raw == null || typeof raw === 'object' ? '' : String(raw).trim();
}

interface FilingRef {
  cik: string;
  accession: string; // with dashes
  indexUrl: string;
  filingDate?: string;
  revisionAt?: string;
}

/** Parse the getcurrent Atom feed into unique filing references. */
export function parseAtomFilings(atomText: string): FilingRef[] {
  const doc = xml.parse(atomText);
  if (!doc || !Object.prototype.hasOwnProperty.call(doc, 'feed')) throw new Error('EDGAR returned an invalid Atom feed');
  const entries = asArray(doc.feed.entry);
  const seen = new Set<string>();
  const out: FilingRef[] = [];
  let eligible = 0;
  for (const entry of entries) {
    // SEC's type=4 is a prefix search: 424B2/40-F also match. Only exact
    // ownership forms belong here; filter before the filing budget/dedup.
    const category = asArray<any>(entry?.category).find((c) => c?.['@_label'] === 'form type');
    const form = String(category?.['@_term'] ?? /^([^ ]+)\s+-/.exec(String(entry?.title ?? ''))?.[1] ?? '').trim().toUpperCase();
    if (!form) throw new Error('EDGAR feed entry has no form type');
    if (form !== '4' && form !== '4/A') continue;
    eligible++;

    const href: string = entry?.link?.['@_href'] ?? '';
    const m = /Archives\/edgar\/data\/(\d+)\/.*?(\d{10}-\d{2}-\d{6})-index/.exec(href);
    if (!m) continue;
    const [, cik, accession] = m;
    // Each filing appears once per associated filer (Issuer + Reporting person);
    // dedupe by accession number.
    if (seen.has(accession)) continue;
    seen.add(accession);
    const updated: string = typeof entry?.updated === 'string' ? entry.updated : '';
    out.push({
      cik,
      accession,
      indexUrl: href.startsWith('http') ? href : `https://www.sec.gov${href}`,
      filingDate: /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : undefined,
      revisionAt: updated.includes('T') && utcInstantMs(updated) !== null ? updated : undefined,
    });
  }
  if (eligible && !out.length) throw new Error('EDGAR feed contains no readable filing references');
  return out;
}

/** Map one parsed ownershipDocument into trades (open-market purchases only). */
export function mapOwnershipDocument(doc: any, ref: FilingRef): RawInsiderTrade[] {
  const od = doc?.ownershipDocument;
  if (!od) return [];

  const issuer = asArray(od.issuer)[0];
  const rawTicker = strVal(issuer?.issuerTradingSymbol);
  if (!isValidTicker(rawTicker) || rawTicker.toUpperCase() === 'NONE') return [];
  const ticker = canonicalTicker(rawTicker);
  const companyName = cleanText(strVal(issuer?.issuerName)) || undefined;

  const reportingOwners = asArray(od.reportingOwner).map(owner => {
    const rel = owner?.reportingOwnerRelationship ?? {};
    const parts: string[] = [];
    const title = cleanText(strVal(rel.officerTitle));
    if (title) parts.push(title);
    else if (isTrue(rel.isOfficer)) parts.push('Officer');
    if (isTrue(rel.isDirector)) parts.push('Dir');
    if (isTrue(rel.isTenPercentOwner)) parts.push('10%');
    return { cik: strVal(owner?.reportingOwnerId?.rptOwnerCik).replace(/^0+/, ''),
      name: cleanText(strVal(owner?.reportingOwnerId?.rptOwnerName)) || 'Unknown',
      role: parts.join(', ') || 'Other' };
  });
  const accession = ref.accession.replace(/-/g, '');
  const amendment = strVal(od.documentType).toUpperCase() === '4/A';
  const trades: RawInsiderTrade[] = [];
  // XML rows belong to the joint report; owner attribution is not encoded per row.
  // Keep all owners as provenance, but never multiply the transaction by owner count.
  for (const [filingRow, tx] of asArray(od.nonDerivativeTable?.nonDerivativeTransaction).entries()) {
    const code = strVal(tx?.transactionCoding?.transactionCode).toUpperCase();
    if (code !== 'P' && !amendment) continue;
    const acquired = strVal(tx?.transactionAmounts?.transactionAcquiredDisposedCode).toUpperCase();
    if (code === 'P' && acquired && acquired !== 'A') continue;
    const shares = numVal(tx?.transactionAmounts?.transactionShares) ?? 0;
    const price = numVal(tx?.transactionAmounts?.transactionPricePerShare);
    if (!(shares > 0) || !Number.isFinite(shares)) continue;
    trades.push({ ticker, companyName,
      insiderName: reportingOwners.map(o => o.name).sort().join(' / ') || 'Unknown',
      role: [...new Set(reportingOwners.map(o => o.role))].join(', ') || 'Other',
      reportingOwners, issuerCik: strVal(issuer?.issuerCik).replace(/^0+/, ''),
      transactionType: code === 'P' ? (isTrue(od.aff10b5One) ? '10b5-1 Purchase' : 'P - Purchase') : code,
      tradeDate: strVal(tx?.transactionDate), filingDate: ref.filingDate, revisionAt: ref.revisionAt,
      shares, price, value: price == null ? 0 : shares * price,
      source: 'edgar', sourceUrl: ref.indexUrl, filingAccession: accession, filingRow,
      transactionId: `filing:${accession}:row:${filingRow}`,
      originalSubmissionDate: strVal(od.dateOfOriginalSubmission) || undefined,
      securityTitle: strVal(tx?.securityTitle),
      ownershipNature: [strVal(tx?.ownershipNature?.directOrIndirectOwnership), strVal(tx?.ownershipNature?.natureOfOwnership)].join('|'),
      amendment, integrityStatus: amendment ? 'unlinked-amendment' : undefined,
    });
  }
  if (amendment && !trades.length) trades.push({
    ticker, companyName, insiderName: reportingOwners.map(o => o.name).sort().join(' / ') || 'Unknown',
    role: reportingOwners.map(o => o.role).join(', ') || 'Other', reportingOwners,
    issuerCik: strVal(issuer?.issuerCik).replace(/^0+/, ''), originalSubmissionDate: strVal(od.dateOfOriginalSubmission) || undefined,
    tradeDate: '', filingDate: ref.filingDate, revisionAt: ref.revisionAt,
    transactionType: 'Unknown', shares: 0, value: 0, source: 'edgar', sourceUrl: ref.indexUrl,
    filingAccession: accession, transactionId: `filing:${accession}:metadata`, amendment: true, integrityStatus: 'unlinked-amendment',
  });
  return trades;
}

/** Locate + fetch a filing's primary Form 4 XML, then map it. */
async function fetchFiling(ref: FilingRef, read: ReadSec): Promise<RawInsiderTrade[]> {
  const folder = `https://www.sec.gov/Archives/edgar/data/${ref.cik}/${ref.accession.replace(/-/g, '')}`;
  const indexText = await read(`${folder}/index.json`);
  const items = asArray<any>(JSON.parse(indexText)?.directory?.item);
  const documents = items.filter((it) => typeof it?.name === 'string' && /^[^/]+\.xml$/i.test(it.name));
  for (const item of documents) {
    const doc = xml.parse(await read(`${folder}/${encodeURIComponent(item.name)}`));
    if (doc?.ownershipDocument) return mapOwnershipDocument(doc, ref);
  }
  throw new Error('EDGAR filing has no readable ownership document');
}

export async function scrapeEdgar(
  _context: BrowserContext,
  reportIssue: (message: string) => void = (message) => console.warn(`[edgar] ${message}`),
): Promise<RawInsiderTrade[]> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const read = createSecReader(deadline);
  const discovered = parseAtomFilings(await read(ATOM_URL));
  const filings = discovered.slice(0, FILING_LIMIT);
  if (discovered.length > filings.length) reportIssue(`EDGAR discovery truncated: ${filings.length}/${discovered.length} filings scheduled`);
  reportIssue('EDGAR current-feed coverage is bounded to the latest 100 feed entries; no complete-window claim');
  if (!filings.length) return [];

  const out: RawInsiderTrade[] = [];
  let next = 0;
  let completed = 0;
  let failed = 0;
  let stopped = false;
  let lastError = '';
  const workers = Array.from({ length: Math.min(CONCURRENCY, filings.length) }, async () => {
    while (next < filings.length && Date.now() < deadline && !stopped) {
      const ref = filings[next++];
      try {
        out.push(...(await fetchFiling(ref, read)));
        completed++;
      } catch (error) {
        failed++;
        lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof SourceHttpError && [403, 429].includes(error.status)) stopped = true;
      }
    }
  });
  await Promise.all(workers);
  const skipped = filings.length - next;
  console.log(`[edgar] ${completed}/${filings.length} filings read; ${out.length} purchases; ${failed} failed; ${skipped} deferred`);
  if (failed || skipped) {
    const message = `EDGAR coverage incomplete: ${completed}/${filings.length} filings read, ${failed} failed, ${skipped} deferred${lastError ? '; ' + lastError : ''}`;
    if (!completed) throw new Error(message);
    reportIssue(message);
  }
  return out;
}
