export type EventDateState = 'valid' | 'unknown' | 'invalid' | 'future';

export function utcDateMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? ms : null;
}

/** ISO date or explicit-offset ISO instant only; never the machine's local timezone. */
export function utcInstantMs(value?: string | null): number | null {
  if (!value) return null;
  const text = value.trim();
  const day = utcDateMs(text);
  if (day !== null) return day;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match || utcDateMs(match[1]) === null || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function eventDate(value?: string | null, now = Date.now()): { state: EventDateState; date: string | null } {
  if (!value?.trim()) return { state: 'unknown', date: null };
  const ms = utcDateMs(value.trim());
  if (ms === null) return { state: 'invalid', date: null };
  if (ms > now) return { state: 'future', date: null };
  return { state: 'valid', date: value.trim() };
}
