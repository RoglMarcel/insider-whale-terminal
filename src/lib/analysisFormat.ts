/** Explicit international K/M/B/T suffixes, including when the UI is German. */
export function compactNumber(value: number | null | undefined, locale = 'en-US'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const [divisor, suffix] = abs >= 1e12 ? [1e12, 'T'] : abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / Number(divisor)) + suffix;
}
export function analysisMoney(value: number | null | undefined, currency: string, locale = 'en-US', compact = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (compact && Math.abs(value) >= 1e6) return `${compactNumber(value, locale)} ${currency}`;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}
