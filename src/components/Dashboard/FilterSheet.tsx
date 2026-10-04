import { Sheet } from '@/components/UI/Sheet';
import { useSignals } from '@/hooks/useSignals';
import type { TimeRange, TypeFilter, ConvictionFilter, SortKey } from '@/types';
import { useI18n } from '@/hooks/useI18n';
import type { TKey } from '@/lib/i18n';

const TIME: { key: TimeRange; label: TKey }[] = [
  { key: '24h', label: 'filter.today' },
  { key: '48h', label: 'filter.48h' },
  { key: 'week', label: 'filter.thisWeek' },
  { key: 'all', label: 'filter.all' },
];

const TYPE: { key: TypeFilter; label: TKey }[] = [
  { key: 'all', label: 'filter.all' },
  { key: 'openmarket', label: 'filter.openMarket' },
  { key: 'options', label: 'filter.options' },
  { key: 'combo', label: 'filter.combo' },
];

const CONVICTION: { key: ConvictionFilter; label: TKey }[] = [
  { key: 'all', label: 'filter.all' },
  { key: 'HIGH', label: 'filter.high' },
  { key: 'WATCH', label: 'filter.watch' },
];

const SORT: { key: SortKey; label: TKey }[] = [
  { key: 'score', label: 'filter.score' },
  { key: 'confidence', label: 'filter.confidence' },
];

/** Full-width option buttons — a 44px row per choice beats a cramped segment. */
function Group<T extends string>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-semibold uppercase tracking-wide text-secondary">{title}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const active = o.key === value;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onChange(o.key)}
              className="rounded-lg px-3.5 text-[15px] font-semibold transition-colors"
              style={{
                minHeight: 44,
                background: active ? 'var(--bg-glass-hover)' : 'var(--bg-glass)',
                color: 'var(--text-primary)',
                border: `1px solid ${active ? 'var(--border-active)' : 'var(--border-glass)'}`,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Mobile filter sheet — replaces four segmented controls that produced ~24px tap
 * targets and four wrapped rows above the signal list (AUDIT B1/H6).
 */
export function FilterSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { filter, setFilter } = useSignals();
  const { t } = useI18n();
  const tr = <T extends string>(opts: { key: T; label: TKey }[]) =>
    opts.map((o) => ({ key: o.key, label: t(o.label) }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('dash.filter')}
      footer={
        <button
          type="button"
          className="btn btn-primary w-full"
          style={{ minHeight: 44 }}
          onClick={onClose}
        >
          {t('filter.showResults')}
        </button>
      }
    >
      <div className="flex flex-col gap-5">
        <Group title={t('filter.timeRange')} options={tr(TIME)} value={filter.timeRange} onChange={(v) => setFilter({ timeRange: v })} />
        <Group title={t('filter.type')} options={tr(TYPE)} value={filter.type} onChange={(v) => setFilter({ type: v })} />
        <Group title={t('filter.conviction')} options={tr(CONVICTION)} value={filter.conviction} onChange={(v) => setFilter({ conviction: v })} />
        <Group title={t('filter.sortBy')} options={tr(SORT)} value={filter.sortBy ?? 'score'} onChange={(v) => setFilter({ sortBy: v })} />
        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-semibold uppercase tracking-wide text-secondary">{t('filter.highlight')}</div>
          <button
            type="button"
            onClick={() => setFilter({ bigPlayersOnly: !filter.bigPlayersOnly })}
            className="flex items-center justify-between rounded-lg px-3.5 text-[15px] font-semibold"
            style={{
              minHeight: 44,
              background: filter.bigPlayersOnly ? 'color-mix(in srgb, #f59e0b 14%, transparent)' : 'var(--bg-glass)',
              color: filter.bigPlayersOnly ? '#fbbf24' : 'var(--text-primary)',
              border: `1px solid ${filter.bigPlayersOnly ? 'color-mix(in srgb, #f59e0b 35%, transparent)' : 'var(--border-glass)'}`,
            }}
          >
            <span> {t('filter.bigPlayersOnly')}</span>
            <span className="text-[13px] text-secondary">{filter.bigPlayersOnly ? t('filter.on') : t('filter.off')}</span>
          </button>
        </div>
      </div>
    </Sheet>
  );
}
