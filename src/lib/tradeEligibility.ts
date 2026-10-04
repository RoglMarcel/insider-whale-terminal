import type { RawInsiderTrade } from '../types';
import { eventDate, utcInstantMs } from './utcDate';
export function admissibleTrade(t: RawInsiderTrade, days?: number, now = Date.now()): boolean {
  if (t.integrityStatus || !Number.isFinite(t.value) || t.value <= 0) return false;
  if (t.dateStatus && t.dateStatus !== 'valid') return false;
  const date = eventDate(t.tradeDate, now);
  if (date.state !== 'valid' || (t.filingDate && eventDate(t.filingDate, now).state !== 'valid')) return false;
  if (t.observedAt && (utcInstantMs(t.observedAt) ?? Infinity) > now) return false;
  if (t.revisionAt && (utcInstantMs(t.revisionAt) ?? Infinity) > now) return false;
  return days === undefined || (now - (utcInstantMs(t.tradeDate) ?? -Infinity)) <= days * 86_400_000;
}
