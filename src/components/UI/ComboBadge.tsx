import { useI18n } from '@/hooks/useI18n';

/** Feature 4 — pulsing combo badge (insider buying + unusual options flow). */
export function ComboBadge({ className = '', pulse = true }: { className?: string; pulse?: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className={`badge ${pulse ? 'combo-pulse' : ''} ${className}`}
      style={{ color: 'var(--accent-blue)', background: 'var(--bg-glass-hover)', border: '1px solid var(--border-glass)' }}
      title={t('badge.comboTitle')}
    >
       {t('badge.combo')}
    </span>
  );
}
