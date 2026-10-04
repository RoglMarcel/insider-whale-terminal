import { GlassCard } from '@/components/UI/GlassCard';
import { useI18n } from '@/hooks/useI18n';
import {
  PORTFOLIO_SMALL_SAMPLE_N,
  type PortfolioMetric,
  type PortfolioStats as Stats,
  type PortfolioWindowKey,
} from '@/types';
import type { TKey } from '@/lib/i18n';

/**
 * The statistics panel — three columns (portfolio · S&P 500 · difference).
 *
 * The rule that matters here is what it does NOT print. A window with less
 * history than the window is long shows `n/a · N days to go`, never a figure
 * scaled up from a shorter period. Extrapolating a 30-day result into a "1
 * year" cell is the fastest way to make every other number on the page
 * worthless, so the type carries `daysRemaining` and this component renders it.
 */

const pct = (v: number | null | undefined, digits = 2): string =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;

const num = (v: number | null | undefined, digits = 2): string => (v == null ? '—' : v.toFixed(digits));

const sign = (v: number | null | undefined): string | undefined =>
  v == null ? undefined : v >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

const WINDOW_LABELS: Record<PortfolioWindowKey, TKey> = {
  '7d': 'pf.stats.7d',
  '30d': 'pf.stats.30d',
  '6m': 'pf.stats.6m',
  '1y': 'pf.stats.1y',
  max: 'pf.stats.max',
};

function Row({
  label,
  metric,
  format,
  pendingLabel,
  hint,
  strong = false,
  colorDiff = true,
}: {
  label: string;
  metric: PortfolioMetric;
  format: (v: number | null) => string;
  /** What to render instead of numbers when the history is too short. */
  pendingLabel: (days: number | null) => string;
  hint?: string;
  strong?: boolean;
  colorDiff?: boolean;
}) {
  const pending = metric.portfolio == null && metric.daysRemaining != null;
  return (
    <tr style={{ borderTop: '1px solid var(--border-glass)' }}>
      <td className="py-2 pr-3">
        <span className={strong ? 'font-bold' : 'font-medium'}>{label}</span>
        {hint && <div className="text-[11px] font-normal text-secondary">{hint}</div>}
      </td>
      {pending ? (
        <td className="py-2 text-right text-xs text-secondary" colSpan={3}>
          {pendingLabel(metric.daysRemaining)}
        </td>
      ) : (
        <>
          <td className="py-2 pr-3 text-right tabular-nums font-semibold">{format(metric.portfolio)}</td>
          <td className="py-2 pr-3 text-right tabular-nums text-secondary">{format(metric.benchmark)}</td>
          <td
            className="py-2 text-right tabular-nums font-semibold"
            style={colorDiff ? { color: sign(metric.diff) } : undefined}
          >
            {format(metric.diff)}
          </td>
        </>
      )}
    </tr>
  );
}

export function PortfolioStatsPanel({ stats }: { stats: Stats }) {
  const { t } = useI18n();
  const pendingLabel = (days: number | null): string =>
    t('pf.stats.pending', { days: Math.max(0, Math.ceil(days ?? 0)) });

  const trades = stats.trades;

  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <GlassCard className="p-4 xl:col-span-3 lg:p-6">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">{t('pf.stats.title')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-secondary">
                <th className="py-1.5 pr-3 font-semibold">{t('pf.stats.metric')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.stats.portfolio')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.stats.benchmark')}</th>
                <th className="py-1.5 text-right font-semibold">{t('pf.stats.diff')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.windows.map((w) => (
                <Row pendingLabel={pendingLabel}
                  key={w.key}
                  label={t(WINDOW_LABELS[w.key])}
                  strong={w.key === 'max'}
                  metric={{
                    portfolio: w.portfolio,
                    benchmark: w.benchmark,
                    diff: w.diff,
                    daysRemaining: w.daysRemaining,
                  }}
                  format={(v) => pct(v)}
                  hint={
                    w.portfolio != null && w.n > 0 && w.n < PORTFOLIO_SMALL_SAMPLE_N
                      ? t('pf.stats.smallSample', { n: w.n })
                      : undefined
                  }
                />
              ))}
              <Row pendingLabel={pendingLabel} label={t('pf.stats.cagr')} metric={stats.cagr} format={(v) => pct(v)} />
              {/* A deeper drawdown is worse, so a NEGATIVE difference here is the
                  good direction — the colour would read backwards. */}
              <Row pendingLabel={pendingLabel}
                label={t('pf.stats.maxDrawdown')}
                metric={stats.maxDrawdown}
                format={(v) => pct(v)}
                colorDiff={false}
              />
              <Row pendingLabel={pendingLabel}
                label={t('pf.stats.volatility')}
                metric={stats.volatility}
                // Volatility has no direction; a leading "+" would read as a gain.
                format={(v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)}
                colorDiff={false}
              />
              <Row pendingLabel={pendingLabel} label={t('pf.stats.sharpe')} metric={stats.sharpe} format={(v) => num(v)} />
            </tbody>
          </table>
        </div>
      </GlassCard>

      <GlassCard className="p-4 xl:col-span-2 lg:p-6">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">{t('pf.trades.title')}</h3>
        <dl className="flex flex-col text-sm">
          <Kv label={t('pf.trades.count')} value={t('pf.trades.closedOpen', { closed: trades.closed, open: trades.open })} />
          <Kv
            label={t('pf.trades.winRate')}
            value={trades.winRate == null ? '—' : `${Math.round(trades.winRate * 100)}%`}
            note={trades.closed > 0 && trades.closed < PORTFOLIO_SMALL_SAMPLE_N ? t('pf.stats.smallSample', { n: trades.closed }) : undefined}
          />
          <Kv
            label={t('pf.trades.avgHold')}
            value={trades.avgHoldDays == null ? '—' : t('pf.trades.days', { n: Math.round(trades.avgHoldDays) })}
          />
          <Kv label={t('pf.trades.avgWinLoss')} value={`${pct(trades.avgWin)} / ${pct(trades.avgLoss)}`} />
          <Kv
            label={t('pf.trades.bestWorst')}
            value={
              trades.best && trades.worst
                ? `${trades.best.ticker} ${pct(trades.best.returnPct)} / ${trades.worst.ticker} ${pct(trades.worst.returnPct)}`
                : '—'
            }
          />
          <Kv label={t('pf.trades.invested')} value={`${(trades.investedRatio * 100).toFixed(1)}%`} />
        </dl>

        {/* The headline of the whole page: immune to cash drag and to the luck of
            when the window happens to start. */}
        <div
          className="mt-4 rounded-xl p-3"
          style={{
            background: 'color-mix(in srgb, var(--accent-blue) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent-blue) 28%, transparent)',
          }}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-secondary">{t('pf.trades.avgAlpha')}</div>
          <div
            className="font-mono-terminal text-2xl font-extrabold tabular-nums"
            style={{ color: sign(trades.avgTradeAlpha) }}
          >
            {pct(trades.avgTradeAlpha)}
            {trades.alphaN > 0 && (
              <span className="ml-2 text-xs font-medium text-secondary">n = {trades.alphaN}</span>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-secondary">{t('pf.trades.avgAlphaHint')}</p>
        </div>
      </GlassCard>
    </div>
  );
}

function Kv({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5" style={{ borderTop: '1px solid var(--border-glass)' }}>
      <dt className="text-secondary">
        {label}
        {note && <span className="ml-1 text-[11px]">· {note}</span>}
      </dt>
      <dd className="shrink-0 text-right font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
