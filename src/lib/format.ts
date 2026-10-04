import { translate, type Lang, type TKey } from './i18n';
import { type ConvictionLevel, type FreshnessLevel, getFreshnessLevel } from '@/types';

/** Compact USD: $5.2M, $450K, $12,340. */
export function formatUSD(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Compact count (no $): 14.7B, 408M, 25K, 950. For share/float counts. */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}K`;
  return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** Data-confidence colour: green > 75, yellow 50–75, red < 50. */
export function confidenceColor(confidence: number | null | undefined): string {
  if (confidence == null || !Number.isFinite(confidence)) return 'var(--text-secondary)';
  if (confidence > 75) return 'var(--accent-green)';
  if (confidence >= 50) return 'var(--accent-yellow)';
  return 'var(--accent-red)';
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/** Party display: single-letter initial + a colour class (Dem blue / Rep red / Ind grey). */
export function partyMeta(party: string | null | undefined): { initial: string; colorClass: string; color: string } {
  const p = (party ?? '').toLowerCase();
  if (p.startsWith('d')) return { initial: 'D', colorClass: 'text-blue-400', color: 'var(--accent-blue)' };
  if (p.startsWith('r')) return { initial: 'R', colorClass: 'text-red-400', color: 'var(--accent-red)' };
  if (p.startsWith('i')) return { initial: 'I', colorClass: 'text-gray-400', color: 'var(--text-secondary)' };
  return { initial: '—', colorClass: 'text-gray-400', color: 'var(--text-secondary)' };
}

export function formatDate(iso: string | null | undefined, lang: Lang = 'en'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined, lang: Lang = 'en'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * These helpers build user-facing prose, so they take the active language.
 * They are pure (no React), which is why the language is a parameter rather
 * than a hook — callers inside components pass `language` from `useI18n()`.
 * `en` is the default so a missed call site degrades to English, not to a
 * crash or a raw key.
 */
export function timeAgo(iso: string | null | undefined, lang: Lang = 'en'): string {
  const T = (k: TKey, v?: Record<string, string | number>) => translate(lang, k, v);
  if (!iso) return T('time.never');
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return T('time.never');
  const sec = Math.round((Date.now() - d) / 1000);
  if (sec < 60) return T('time.justNow');
  const min = Math.round(sec / 60);
  if (min < 60) return T('time.minutesAgo', { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return T('time.hoursAgo', { n: hr });
  const day = Math.round(hr / 24);
  return T('time.daysAgoShort', { n: day });
}

export function convictionColor(level: ConvictionLevel): string {
  switch (level) {
    case 'HIGH':
      return 'var(--accent-green)';
    case 'WATCH':
      return 'var(--accent-yellow)';
    default:
      return 'var(--text-secondary)';
  }
}

export function scoreColor(score: number): string {
  if (score >= 80) return 'var(--accent-green)';
  if (score >= 50) return 'var(--accent-yellow)';
  return 'var(--text-secondary)';
}

export function convictionLabelKey(level: ConvictionLevel): TKey {
  switch (level) {
    case 'HIGH':
      return 'conviction.high';
    case 'WATCH':
      return 'conviction.watch';
    default:
      return 'conviction.low';
  }
}

// ── Feature 1 — freshness badge meta ──
export interface FreshnessMeta {
  level: FreshnessLevel;
  labelKey: TKey;
  color: string;
}

export function freshnessMeta(ageDays: number | null | undefined): FreshnessMeta {
  const level = getFreshnessLevel(ageDays ?? null);
  switch (level) {
    case 'fresh':
      return { level, labelKey: 'fresh.fresh', color: 'var(--accent-green)' };
    case 'recent':
      return { level, labelKey: 'fresh.recent', color: 'var(--accent-yellow)' };
    case 'aging':
      return { level, labelKey: 'fresh.aging', color: '#ff9f0a' };
    default:
      return { level, labelKey: 'fresh.stale', color: 'var(--accent-red)' };
  }
}

export function ageLabel(ageDays: number | null | undefined, lang: Lang = 'en'): string {
  if (ageDays == null) return translate(lang, 'fresh.unknownAge');
  if (ageDays < 1) return translate(lang, 'fresh.under24h');
  const d = Math.round(ageDays);
  return translate(lang, d === 1 ? 'fresh.dayAgo' : 'fresh.daysAgo', { n: d });
}

// ── Feature 5 — earnings countdown chip color ──
export function earningsChipColor(days: number | null | undefined): string {
  if (days == null) return 'var(--text-secondary)';
  if (days <= 7) return 'var(--accent-red)';
  if (days <= 15) return 'var(--accent-yellow)';
  return 'var(--text-secondary)';
}

// ── Feature 6 — accuracy tier color ──
export function accuracyColor(accuracy: number): string {
  if (accuracy > 0.65) return 'var(--accent-green)';
  if (accuracy >= 0.5) return 'var(--accent-yellow)';
  return 'var(--text-secondary)';
}
