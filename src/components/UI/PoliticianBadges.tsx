import type { PoliticianComboTier } from '@/types';
import { useI18n } from '@/hooks/useI18n';
import type { TKey } from '@/lib/i18n';

/**
 * Congressional-signal visual hierarchy. The tier badge REPLACES the regular
 * orange COMBO badge whenever a politician combo tier is present; MEGA_SIGNAL
 * additionally renders a full-width pulsing banner above the card.
 */

const TIER_STYLE: Record<PoliticianComboTier, { bg: string; border: string; label: TKey; title: TKey }> = {
  POLITICIAN_INSIDER: {
    bg: 'var(--accent-purple)',
    border: 'var(--accent-purple)',
    label: 'badge.polInsider',
    title: 'badge.polInsiderTitle',
  },
  POLITICIAN_OPTIONS: {
    bg: 'var(--accent-blue)',
    border: 'var(--accent-blue)',
    label: 'badge.polOptions',
    title: 'badge.polOptionsTitle',
  },
  MEGA_SIGNAL: {
    bg: 'var(--accent-red)',
    border: 'var(--accent-red)',
    label: 'badge.mega',
    title: 'badge.megaTitle',
  },
};

/** Small tier badge for the signal card / modal header. */
export function PoliticianComboBadge({ tier, className = '' }: { tier: PoliticianComboTier; className?: string }) {
  const s = TIER_STYLE[tier];
  const { t } = useI18n();
  return (
    <span
      className={`badge ${tier === 'MEGA_SIGNAL' ? 'mega-signal-banner' : ''} ${className}`}
      style={{ color: s.bg, background: 'var(--bg-glass-hover)', border: `1px solid color-mix(in srgb, ${s.border} 35%, var(--border-glass))` }}
      title={t(s.title)}
    >
      {t(s.label)}
    </span>
  );
}

/** Full-width pulsing red banner for MEGA_SIGNAL — unmissable, sits above the card. */
export function MegaSignalBanner({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div
      className={`mega-signal-banner flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2 text-center text-xs font-extrabold uppercase tracking-wide ${className}`}
      style={{
        color: 'var(--accent-red)',
        background: 'var(--bg-glass)',
        border: '1px solid color-mix(in srgb, var(--accent-red) 60%, #fff 0%)',
        boxShadow: 'none',
      }}
      title={t('badge.megaBannerTitle')}
    >
       {t('badge.megaBanner')}
    </div>
  );
}

/** " N politicians" count badge. */
export function PoliticianCountBadge({ count, className = '' }: { count: number; className?: string }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-bold ${className}`}
      style={{ color: 'var(--accent-purple)', background: 'color-mix(in srgb, var(--accent-purple) 16%, transparent)' }}
      title={t(count === 1 ? 'badge.politicianCountTitleOne' : 'badge.politicianCountTitle', { count })}
    >
       {t(count === 1 ? 'badge.politicianOne' : 'badge.politicianMany', { count })}
    </span>
  );
}
