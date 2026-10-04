import { freshnessMeta } from '@/lib/format';
import { useI18n } from '@/hooks/useI18n';

/** Feature 1 — signal freshness pill ( FRESH /  RECENT /  AGING /  STALE). */
export function FreshnessBadge({ ageDays, className = '' }: { ageDays: number | null | undefined; className?: string }) {
  const m = freshnessMeta(ageDays);
  const { t } = useI18n();
  return (
    <span
      className={`badge ${className}`}
      style={{ color: m.color, background: `color-mix(in srgb, ${m.color} 16%, transparent)` }}
    >
      {t(m.labelKey)}
    </span>
  );
}
