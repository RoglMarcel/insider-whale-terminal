import type { RawInsiderTrade } from '../src/types';
export function filingAccession(t: RawInsiderTrade): string | undefined {
  if (t.filingAccession) return t.filingAccession.replace(/-/g, '');
  const match = /(?:\b(\d{10}-\d{2}-\d{6})\b|\/(\d{18})\/)/.exec(t.sourceUrl ?? '');
  return match ? (match[1] || match[2]).replace(/-/g, '') : undefined;
}
