import type { MouseEvent } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useStore } from '@/store/useStore';
import { GlassCard } from '@/components/UI/GlassCard';
import { ScoreGauge } from '@/components/UI/ScoreGauge';
import { ConvictionBadge } from '@/components/UI/ConvictionBadge';
import { StarIcon, TrashIcon } from '@/components/UI/icons';
import { formatUSD, timeAgo, formatDateTime } from '@/lib/format';
import { api } from '@/lib/ipc';

// Recharts is only needed here; lazy so it never blocks the alerts list.
const ScoreTrendChart = lazy(() => import('./ScoreTrendChart'));
import type { Signal } from '@/types';

const ACCENT_BLUE = 'var(--accent-blue)';
const GRID = 'rgba(128,128,128,0.2)';

export function WatchlistView() {
  const { t, language } = useI18n();
  // Axis furniture costs more width than it explains on a phone.
  const [compactChart, setCompactChart] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  useEffect(() => {
    const onResize = () => setCompactChart(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const { watchlist, removeWatch } = useWatchlist();
  const openSignal = useStore((s) => s.openSignal);

  const [selectedTicker, setSelectedTicker] = useState<string>('');
  const [history, setHistory] = useState<Signal[]>([]);

  useEffect(() => {
    if (watchlist.length > 0) {
      if (!watchlist.some((w) => w.ticker === selectedTicker)) {
        setSelectedTicker(watchlist[0].ticker);
      }
    } else {
      setSelectedTicker('');
    }
  }, [watchlist, selectedTicker]);

  useEffect(() => {
    if (!selectedTicker) {
      setHistory([]);
      return;
    }
    let active = true;
    api.signals
      .getHistory(selectedTicker)
      .then((h) => active && setHistory(h))
      .catch(() => active && setHistory([]));
    return () => {
      active = false;
    };
  }, [selectedTicker]);

  const chartData = useMemo(
    () =>
      history.map((h) => ({
        time: formatDateTime(h.scrapedAt, language),
        score: h.score,
      })),
    [history, language],
  );

  if (watchlist.length === 0) {
    return (
      <GlassCard className="animate-fade-in flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-2xl"
          style={{ background: 'var(--bg-glass)', color: 'var(--accent-yellow)' }}
        >
          <StarIcon size={28} />
        </div>
        <div className="text-lg font-bold">{t('watch.empty')}</div>
        <p className="max-w-md text-sm text-secondary">
          {t('watch.emptyHint')}
        </p>
      </GlassCard>
    );
  }

  return (
    <div className="workspace-view animate-fade-in">
      {/* Watchlist cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {watchlist.map((item) => {
          const signal = item.signal;
          const onRemove = (e: MouseEvent) => {
            e.stopPropagation();
            void removeWatch(item.ticker);
          };
          return (
            <GlassCard
              key={item.ticker}
              hover
              onClick={() => openSignal(item.ticker)}
              role="button"
              tabIndex={0}
              aria-label={item.ticker}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSignal(item.ticker); } }}
              className="flex items-center gap-4 p-5"
            >
              {signal ? (
                <ScoreGauge score={signal.score} size={64} stroke={7} />
              ) : (
                <div
                  className="flex h-16 w-16 items-center justify-center rounded-full text-xs text-secondary"
                  style={{ border: '2px dashed var(--border-glass)' }}
                >
                  N/A
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-lg font-extrabold">{item.ticker}</div>
                <div className="truncate text-xs text-secondary">
                  {signal?.companyName || t('watch.added', { when: timeAgo(item.addedAt, language) })}
                </div>
                <div className="mt-1.5">
                  {signal ? (
                    <ConvictionBadge level={signal.convictionLevel} />
                  ) : (
                    <span className="text-xs text-secondary">{t('watch.noSignal')}</span>
                  )}
                </div>
                {signal && (
                  <div className="mt-1 text-xs text-secondary">{t('stats.insiderBuys', { amount: formatUSD(signal.totalDollarVolume) })}</div>
                )}
              </div>
              <button className="icon-btn h-9 w-9" onClick={onRemove} aria-label={t('card.removeFromWatchlist')} title={t('card.removeFromWatchlist')}>
                <TrashIcon size={16} />
              </button>
            </GlassCard>
          );
        })}
      </div>

      {/* Score Trend Card */}
      <GlassCard className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-bold uppercase tracking-wide text-secondary">{t('watch.scoreTrend')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {watchlist.map((w) => (
              <button
                key={w.ticker}
                onClick={() => setSelectedTicker(w.ticker)}
                className="rounded-lg px-2.5 py-1 text-xs font-semibold transition-all"
                style={
                  w.ticker === selectedTicker
                    ? { background: ACCENT_BLUE, color: '#fff' }
                    : { background: 'var(--bg-glass)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }
                }
              >
                {w.ticker}
              </button>
            ))}
          </div>
        </div>

        {chartData.length > 1 ? (
          <div style={{ width: '100%', height: 280 }}>
            <Suspense fallback={<div className="skeleton h-full w-full" />}>
              <ScoreTrendChart data={chartData} compact={compactChart} />
            </Suspense>
          </div>
        ) : (
          <div className="py-16 text-center text-sm text-secondary">
            {selectedTicker
              ? t('watch.notEnoughHistory', { ticker: selectedTicker })
              : t('watch.addToTrack')}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
