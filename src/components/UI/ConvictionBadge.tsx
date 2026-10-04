import type { ConvictionLevel } from '@/types';
import { useI18n } from '@/hooks/useI18n';
import { convictionColor, convictionLabelKey } from '@/lib/format';

interface ConvictionBadgeProps {
  level: ConvictionLevel;
  className?: string;
}

export function ConvictionBadge({ level, className = '' }: ConvictionBadgeProps) {
  const { t } = useI18n();
  const color = convictionColor(level);
  return (
    <span
      className={`badge ${className}`}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      />
      {t(convictionLabelKey(level))}
    </span>
  );
}
