import type { TimeRange, TypeFilter, ConvictionFilter, SortKey } from '@/types';
import { useSignals } from '@/hooks/useSignals';
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

function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'md' | 'sm';
}) {
  return (
    <div
      className="inline-flex rounded-xl p-1"
      style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            className={`rounded-lg font-semibold transition-all ${size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm'}`}
            style={
              active
                ? { background: 'var(--bg-glass-hover)', color: 'var(--text-primary)' }
                : { color: 'var(--text-secondary)', background: 'transparent' }
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Removable chips for every non-default filter, so an empty list is explainable. */
export function ActiveFilterChips() {
  const { filter, setFilter } = useSignals();
  const { t } = useI18n();
  const chips: { label: string; clear: () => void }[] = [];
  if (filter.timeRange !== 'all') {
    chips.push({
      label: (() => {
        const m = TIME.find((o) => o.key === filter.timeRange);
        return m ? t(m.label) : filter.timeRange;
      })(),
      clear: () => setFilter({ timeRange: 'all' }),
    });
  }
  if (filter.type !== 'all') {
    const m = TYPE.find((o) => o.key === filter.type);
    chips.push({ label: m ? t(m.label) : filter.type, clear: () => setFilter({ type: 'all' }) });
  }
  if (filter.conviction !== 'all') {
    chips.push({ label: t(filter.conviction === 'HIGH' ? 'filter.high' : 'filter.watch'), clear: () => setFilter({ conviction: 'all' }) });
  }
  if (filter.bigPlayersOnly)
    chips.push({ label: t('filter.bigPlayersChip'), clear: () => setFilter({ bigPlayersOnly: false }) });
  if (filter.search?.trim()) chips.push({ label: `“${filter.search.trim()}”`, clear: () => setFilter({ search: '' }) });
  if (!chips.length) return null;

  return (
    <div className="flex flex-wrap gap-2 md:hidden">
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          onClick={c.clear}
          className="inline-flex items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold"
          style={{
            minHeight: 44,
            background: 'color-mix(in srgb, var(--accent-blue) 14%, transparent)',
            color: 'var(--accent-blue)',
            border: '1px solid color-mix(in srgb, var(--accent-blue) 30%, transparent)',
          }}
          aria-label={t('filter.removeFilter', { label: c.label })}
        >
          {c.label}
          <span aria-hidden="true" className="text-[15px] leading-none">×</span>
        </button>
      ))}
    </div>
  );
}

export function FilterBar() {
  const { filter, setFilter } = useSignals();
  const { t } = useI18n();
  const tr = <T extends string>(opts: { key: T; label: TKey }[]) =>
    opts.map((o) => ({ key: o.key, label: t(o.label) }));
  return (
    // Segmented controls are a pointer pattern; on mobile the same options live
    // in the filter sheet with 44px rows (see FilterSheet).
    <div className="hidden flex-col gap-3 md:flex">
      <div className="flex flex-row items-center justify-between gap-4 flex-wrap">
        <Segmented options={tr(TIME)} value={filter.timeRange} onChange={(v) => setFilter({ timeRange: v })} />
        <button
          onClick={() => setFilter({ bigPlayersOnly: !filter.bigPlayersOnly })}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 border select-none ${
            filter.bigPlayersOnly
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30 shadow-[0_0_12px_rgba(245,158,11,0.15)]'
              : 'text-secondary bg-transparent hover:bg-[rgba(255,255,255,0.04)] hover:text-white border-transparent'
          }`}
        >

          {t('filter.bigPlayersOnly')}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-secondary">{t('filter.type')}</span>
          <Segmented size="sm" options={tr(TYPE)} value={filter.type} onChange={(v) => setFilter({ type: v })} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-secondary">{t('filter.conviction')}</span>
          <Segmented
            size="sm"
            options={tr(CONVICTION)}
            value={filter.conviction}
            onChange={(v) => setFilter({ conviction: v })}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-secondary">{t('filter.sort')}</span>
          <Segmented
            size="sm"
            options={tr(SORT)}
            value={filter.sortBy ?? 'score'}
            onChange={(v) => setFilter({ sortBy: v })}
          />
        </div>
      </div>
    </div>
  );
}
