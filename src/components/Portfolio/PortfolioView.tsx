import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/UI/GlassCard';
import { RefreshIcon } from '@/components/UI/icons';
import { useI18n } from '@/hooks/useI18n';
import { api, isWeb } from '@/lib/ipc';
import { formatDate, formatDateTime, timeAgo } from '@/lib/format';
import { addDaysYmd, diffDaysYmd, emptyPortfolioState } from '@/lib/portfolio-rules';
import type { PortfolioConfig, PortfolioState } from '@/types';
import type { TKey } from '@/lib/i18n';
import { PortfolioStatsPanel } from './PortfolioStats';
import { ClosedTradesTable, OpenPositionsTable } from './PortfolioPositions';
import { RulesCard } from './RulesCard';
import type { EquityChartPoint, TradeMarker } from './EquityChart';

// Recharts is ~100 kB and only this view draws it — same treatment as
// ScoreTrendChart, so the alerts list still paints without it.
const PortfolioComparison = lazy(() => import('./PortfolioComparison'));
const EquityChart = lazy(() => import('./EquityChart'));

type RangeKey = '7d' | '30d' | '90d' | '6m' | '1y' | 'max';

const RANGES: { key: RangeKey; days: number | null; label: TKey }[] = [
  { key: '7d', days: 7, label: 'pf.range.7d' },
  { key: '30d', days: 30, label: 'pf.range.30d' },
  { key: '90d', days: 90, label: 'pf.range.90d' },
  { key: '6m', days: 182, label: 'pf.range.6m' },
  { key: '1y', days: 365, label: 'pf.range.1y' },
  { key: 'max', days: null, label: 'pf.range.max' },
];

const LS = {
  range: 'pf.range',
  unit: 'pf.unit',
  log: 'pf.log',
  markers: 'pf.markers',
};

function readLs<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Persisted booleans live as '1'/'0' so nothing has to be JSON-parsed back. */
function readLsFlag(key: string, fallback: boolean): boolean {
  return readLs<string>(key, fallback ? '1' : '0') === '1';
}

function writeLs(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

const money = (v: number): string =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Axis labels on a phone: no cents. The tooltip still carries the exact figure. */
const moneyShort = (v: number): string => '$' + Math.round(v).toLocaleString('en-US');
/** Zero carries no sign: a "+0.0%" axis tick reads as a rounded-down gain. */
const pct = (v: number | null | undefined, digits = 2): string => {
  if (v == null) return '—';
  const shown = (v * 100).toFixed(digits);
  return `${Number(shown) > 0 ? '+' : ''}${shown}%`;
};
const sign = (v: number | null | undefined): string | undefined =>
  v == null ? undefined : v >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

function Toggle({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string; disabled?: boolean; title?: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg" style={{ border: '1px solid var(--border-glass)' }}>
      {options.map((o) => (
        <button
          key={o.key}
          aria-pressed={value === o.key}
          type="button"
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.key)}
          // A window we cannot compute is DISABLED, not empty: an empty chart
          // reads as "the strategy did nothing", which is a different claim.
          className="px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35"
          style={{
            background: value === o.key ? 'var(--bg-glass-hover)' : 'transparent',
            color: value === o.key ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PortfolioView() {
  const { t, language } = useI18n();
  const [portfolio, setState] = useState<PortfolioState>(() => emptyPortfolioState());
  const [variant, setVariant] = useState<'overlay' | 'insider'>('overlay');
  const state = variant === 'insider' && portfolio.insiderOnly ? portfolio.insiderOnly.state : portfolio;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'sync' | 'rebuild' | 'config' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [range, setRange] = useState<RangeKey>(() => readLs<RangeKey>(LS.range, 'max'));
  const [unit, setUnit] = useState<'$' | '%'>(() => readLs<'$' | '%'>(LS.unit, '%'));
  const [logScale, setLogScale] = useState(() => readLsFlag(LS.log, false));
  const [showMarkers, setShowMarkers] = useState(() => readLsFlag(LS.markers, true));
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);

  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => api.portfolio
      .getState()
      .then((s) => active && setState(s))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));
    void load();
    const unsubscribe = api.app.onSignalsUpdated(() => { void load(); });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const run = async (kind: 'sync' | 'rebuild') => {
    if (kind === 'rebuild' && !window.confirm(t('pf.action.rebuildConfirm'))) return;
    setBusy(kind);
    setError(null);
    try {
      setState(kind === 'sync' ? await api.portfolio.sync() : await api.portfolio.rebuild());
    } catch (e) {
      setError(t('pf.action.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const applyConfig = async (partial: Partial<PortfolioConfig>) => {
    setBusy('config');
    setError(null);
    try {
      setState(await api.portfolio.setConfig(partial));
    } catch (e) {
      setError(t('pf.action.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const { equity, meta, config, stats } = state;
  const spanDays = equity.length >= 2 ? diffDaysYmd(equity[0].date, equity[equity.length - 1].date) : 0;

  // A range is only offered when the history actually covers it.
  const rangeOptions = RANGES.map((r) => ({
    key: r.key,
    label: t(r.label),
    disabled: r.days != null && spanDays < r.days,
    title: r.days != null && spanDays < r.days ? t('pf.range.tooShort', { days: r.days - spanDays }) : undefined,
  }));
  const effectiveRange: RangeKey = rangeOptions.find((o) => o.key === range && !o.disabled) ? range : 'max';

  const windowed = useMemo(() => {
    const days = RANGES.find((r) => r.key === effectiveRange)?.days ?? null;
    if (days == null || !equity.length) return equity;
    const cutoff = addDaysYmd(equity[equity.length - 1].date, -days);
    const idx = equity.findIndex((p) => p.date >= cutoff);
    return idx <= 0 ? equity : equity.slice(idx - 1);
  }, [equity, effectiveRange]);

  const chartData: EquityChartPoint[] = useMemo(() => {
    if (!windowed.length) return [];
    const base = windowed[0];
    // In % mode BOTH series are re-based to the same starting capital, which is
    // the only presentation where equal vertical distance means equal return.
    // A window that starts at the top of the book is based on the capital
    // COMMITTED, not on day 0's value — day 0 is already net of entry slippage,
    // and basing on it would put the chart 5 bp away from the headline that
    // reads off the same window. Both series therefore open at −0.05% rather
    // than 0%: the entry cost is real and both paid it.
    const atStart = !!equity.length && base.date === equity[0].date && config.startingCash > 0;
    const pBase = atStart ? config.startingCash : base.equity;
    const bBase = atStart ? config.startingCash : base.benchmark;
    const iBase = atStart ? config.startingCash : base.equityIdle;
    return windowed.map((p) =>
      unit === '$'
        ? { date: p.date, portfolio: p.equity, benchmark: p.benchmark, idle: p.equityIdle }
        : {
            date: p.date,
            portfolio: p.equity / pBase - 1,
            benchmark: p.benchmark / bBase - 1,
            idle: p.equityIdle / iBase - 1,
          },
    );
  }, [windowed, unit, equity, config.startingCash]);

  // One marker per SESSION, carrying that day's tickers. Three trades on
  // 2026-08-31 used to push three separate dots onto the same pixel, and the
  // `kind-date` key collided in React as soon as two of them were the same kind.
  const markers: TradeMarker[] = useMemo(() => {
    if (!showMarkers || !chartData.length) return [];
    const byDate = new Map(chartData.map((p) => [p.date, p.portfolio]));
    const grouped = new Map<string, TradeMarker>();
    for (const e of state.events) {
      if (e.kind !== 'buy' && e.kind !== 'sell') continue;
      const v = byDate.get(e.date);
      if (v == null || !e.ticker) continue;
      let m = grouped.get(e.date);
      if (!m) {
        m = { date: e.date, value: v, buys: [], sells: [] };
        grouped.set(e.date, m);
      }
      (e.kind === 'buy' ? m.buys : m.sells).push(e.ticker);
    }
    for (const m of grouped.values()) {
      m.buys.sort();
      m.sells.sort();
    }
    return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [state.events, chartData, showMarkers]);

  // The divider is drawn on a CATEGORY axis, so it has to name a date that is
  // actually a tick. `liveStart` is the first day a live signal was stored and
  // can easily be a Saturday, which no session matches — snap it forward to the
  // first session in view, or the line silently never renders.
  const liveInWindow = useMemo(() => {
    if (!meta.liveStart) return null;
    return windowed.find((p) => p.date >= (meta.liveStart as string))?.date ?? null;
  }, [windowed, meta.liveStart]);

  const last = equity[equity.length - 1] ?? null;
  const maxWindow = stats.windows.find((w) => w.key === 'max');

  // Percentages keep one decimal even on a phone: rounding them to whole points
  // turns an evenly spaced axis into −4 / −2 / +1 / +4 / +6.
  const tickFormatter = compact ? (v: number) => (unit === '$' ? moneyShort(v) : pct(v, 1)) : undefined;

  const quality: string[] = [];
  if (meta.skippedNoCash) quality.push(t('pf.quality.skipped', { n: meta.skippedNoCash }));
  if (meta.skippedCap) quality.push(t('pf.quality.capped', { n: meta.skippedCap }));
  if (meta.untradableTickers.length) quality.push(t('pf.quality.missing', { n: meta.untradableTickers.length }));
  if (meta.suspectPrices) quality.push(t('pf.quality.suspect', { n: meta.suspectPrices }));
  if (meta.restatedDays) quality.push(t('pf.quality.restated', { n: meta.restatedDays }));

  return (
    <div className="portfolio-dashboard animate-fade-in" data-portfolio={variant}>
      <Suspense fallback={<div className="text-sm text-secondary">…</div>}>
        <PortfolioComparison portfolio={portfolio} />
      </Suspense>
      <div className="portfolio-switch" role="group" aria-label={t('pf.compare.details')}>
        <button className="btn" aria-pressed={variant === 'overlay'} onClick={() => setVariant('overlay')}>{t('pf.compare.overlay')}</button>
        <button className="btn" disabled={!portfolio.insiderOnly} aria-pressed={variant === 'insider'} onClick={() => setVariant('insider')}>{t('pf.compare.insider')}</button>
      </div>
      {/* ── Headline ── */}
      <GlassCard className="portfolio-headline">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="portfolio-metrics">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-secondary">{t('pf.headline.value')}</div>
              <div className="font-mono-terminal text-2xl font-extrabold tabular-nums lg:text-3xl">
                {last ? money(last.equity) : '—'}
              </div>
              <div className="text-sm font-semibold tabular-nums" style={{ color: sign(maxWindow?.portfolio) }}>
                {pct(maxWindow?.portfolio)}
                {last && (
                  <span className="ml-2 font-normal text-secondary">
                    {last.equity - config.startingCash >= 0 ? '+' : '−'}
                    {money(Math.abs(last.equity - config.startingCash))}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-secondary">{t('pf.headline.benchmark')}</div>
              <div className="font-mono-terminal text-2xl font-extrabold tabular-nums text-secondary lg:text-3xl">
                {last ? money(last.benchmark) : '—'}
              </div>
              <div className="text-sm font-semibold tabular-nums text-secondary">{pct(maxWindow?.benchmark)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-secondary">{t('pf.headline.edge')}</div>
              <div
                className="font-mono-terminal text-2xl font-extrabold tabular-nums lg:text-3xl"
                style={{ color: sign(maxWindow?.diff) }}
              >
                {pct(maxWindow?.diff)}
              </div>
              <div className="text-xs text-secondary">
                {meta.firstDate ? t('pf.headline.sinceStart', { date: formatDate(meta.firstDate, language) }) : ''}
              </div>
            </div>
          </div>

          {/* Desktop can run the simulation; the hosted build reads a published
              result and must not offer buttons that cannot do anything. */}
          {!isWeb && !meta.readOnly && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <button className="btn btn-primary" onClick={() => void run('sync')} disabled={busy !== null}>
                <RefreshIcon size={15} className={busy === 'sync' ? 'animate-spin' : ''} />
                {busy === 'sync' ? t('pf.action.syncing') : t('pf.action.sync')}
              </button>
              <button className="btn" onClick={() => void run('rebuild')} disabled={busy !== null}>
                {busy === 'rebuild' ? t('pf.action.rebuilding') : t('pf.action.rebuild')}
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-secondary">
          {meta.priceAsOf && <span>{t('pf.headline.asOf', { date: formatDate(meta.priceAsOf, language) })}</span>}
          {meta.lastRun && <span>· {t('pf.meta.lastRun', { when: timeAgo(meta.lastRun, language) })}</span>}
          {!isWeb && meta.readOnly && <span>· {t('pf.meta.readOnly')}</span>}
        </div>

        {error && (
          <div className="mt-3 text-xs text-secondary">
            {isWeb ? t('ui.loadError') : error}
          </div>
        )}
        {!isWeb && meta.note && <div className="mt-3 text-xs text-secondary">{meta.note}</div>}
      </GlassCard>

      {/* ── Chart ── */}
      <GlassCard className="portfolio-chart">
        {chartData.length >= 2 && <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Toggle
            options={rangeOptions}
            value={effectiveRange}
            onChange={(v) => {
              setRange(v as RangeKey);
              writeLs(LS.range, v);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Toggle
              options={[
                { key: '%', label: t('pf.chart.unitPercent') },
                { key: '$', label: t('pf.chart.unitDollar') },
              ]}
              value={unit}
              onChange={(v) => {
                setUnit(v as '$' | '%');
                writeLs(LS.unit, v);
              }}
            />
            <Toggle
              options={[
                { key: 'lin', label: t('pf.chart.scaleLinear') },
                // A log axis needs strictly positive values; the % view crosses
                // zero, so the toggle is only meaningful in the $ view.
                { key: 'log', label: t('pf.chart.scaleLog'), disabled: unit === '%' },
              ]}
              value={logScale && unit === '$' ? 'log' : 'lin'}
              onChange={(v) => {
                setLogScale(v === 'log');
                writeLs(LS.log, v === 'log' ? '1' : '0');
              }}
            />
          </div>
        </div>}

        <div className="portfolio-chart-canvas">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-secondary">…</div>
          ) : chartData.length < 2 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <div className="text-sm font-semibold">{t('pf.headline.noData')}</div>
              <div className="max-w-sm text-xs text-secondary">
                {/* Before opening day "run a sync to compute it" is wrong advice:
                    there is nothing to compute yet, and the hosted build has no
                    button to press either. */}
                {!equity.length && config.inceptionDate && config.inceptionDate > new Date().toISOString().slice(0, 10)
                  ? t('pf.headline.opensOn', { date: formatDate(config.inceptionDate, language) })
                  : t(isWeb ? 'ui.noPortfolioHint' : 'pf.headline.noDataHint')}
              </div>
            </div>
          ) : (
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-secondary">…</div>}>
              <EquityChart
                data={chartData}
                unit={unit}
                logScale={logScale && unit === '$'}
                showIdle={false}
                portfolioColor={variant === 'insider' ? 'var(--portfolio-insider)' : 'var(--portfolio-overlay)'}
                markers={markers}
                liveFrom={liveInWindow}
                compact={compact}
                labels={{
                  portfolio: variant === 'insider' ? t('pf.compare.insider') : t('pf.chart.portfolio'),
                  benchmark: t('pf.chart.benchmark'),
                  idle: t('pf.chart.idle'),
                  difference: t('pf.chart.difference'),
                  liveFrom: meta.liveStart ? t('pf.chart.liveFrom', { date: formatDate(meta.liveStart, language) }) : '',
                  buy: t('pf.chart.buy'),
                  sell: t('pf.chart.sell'),
                  more: (n: number) => t('pf.chart.moreTrades', { n }),
                }}
                formatValue={(v) => (unit === '$' ? money(v) : pct(v, 1))}
                formatTick={tickFormatter}
                formatDate={(d) => formatDate(d, language)}
              />
            </Suspense>
          )}
        </div>

        {/* Series toggles and the how-to-read caption describe a chart. With no
            curve drawn they are two switches that change nothing and a
            paragraph about lines that are not there. */}
        {chartData.length >= 2 && (
        <>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-secondary">
            <input
              type="checkbox"
              checked={showMarkers}
              onChange={(e) => {
                setShowMarkers(e.target.checked);
                writeLs(LS.markers, e.target.checked ? '1' : '0');
              }}
            />
            {t('pf.chart.showTrades')}
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-secondary">{t('pf.chart.hint')}</p>
        </>
        )}
      </GlassCard>

      <PortfolioStatsPanel stats={stats} />

      <OpenPositionsTable positions={state.open} />
      <ClosedTradesTable trades={state.closed} />

      <RulesCard
        description={variant === 'insider' ? t('pf.compare.rules') : undefined}
        config={config}
        meta={meta}
        busy={busy === 'config'}
        onApplyConfig={!isWeb && variant === 'overlay' ? (partial) => void applyConfig(partial) : undefined}
      />

      {/* ── Data quality — visible, never swallowed ── */}
      <GlassCard className="p-4 lg:px-6">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
          <span className="font-semibold uppercase tracking-wide text-secondary">{t('pf.quality.title')}</span>
          <span className="text-secondary">
            {meta.available ? (quality.length ? quality.join(' · ') : t('pf.quality.clean')) : t('ui.noPortfolioHint')}
            {meta.untradableTickers.length > 0 && (
              <> · {t('pf.quality.untradable', { tickers: meta.untradableTickers.join(', ') })}</>
            )}
          </span>
          {meta.lastRun && <span className="ml-auto text-secondary">{formatDateTime(meta.lastRun, language)}</span>}
        </div>
      </GlassCard>
    </div>
  );
}
