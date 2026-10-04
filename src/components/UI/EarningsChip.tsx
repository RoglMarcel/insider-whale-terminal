import { earningsChipColor } from '@/lib/format';
import { useI18n } from '@/hooks/useI18n';

/** Feature 5 — earnings countdown chip, shown only when earnings are ≤ 30 days out. */
export function EarningsChip({
  days,
  timing,
  className = '',
}: {
  days: number | null | undefined;
  timing?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  if (days == null || days < 0 || days > 30) return null;
  const color = earningsChipColor(days);
  return (
    <span
      className={`badge ${className}`}
      style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
      title={
        timing
          ? t(timing === 'AMC' ? 'badge.earningsAmc' : 'badge.earningsBmo')
          : t('badge.earningsUpcoming')
      }
    >
       {t('badge.earningsIn', { days })}
    </span>
  );
}
