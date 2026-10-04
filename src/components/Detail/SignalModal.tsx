import { displayText } from '@/lib/display-text';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { createPortal } from 'react-dom';
import { useStore } from '@/store/useStore';
import { useWatchlist } from '@/hooks/useWatchlist';
import { type Signal, type InsiderTrackRecord, type SignalPerformance, type NewsItem, classifyTransaction, normalizeInsiderName } from '@/types';
import { api } from '@/lib/ipc';
import { ScoreGauge } from '@/components/UI/ScoreGauge';
import { ConvictionBadge } from '@/components/UI/ConvictionBadge';
import { ComboBadge } from '@/components/UI/ComboBadge';
import { PoliticianComboBadge, MegaSignalBanner } from '@/components/UI/PoliticianBadges';
import { FairValuePanel } from '@/components/Valuation/FairValuePanel';
import { ScoreBreakdown } from './ScoreBreakdown';
import { FairValuePanel as AlertFairValuePanel } from './FairValuePanel';
import { InsiderTable } from './InsiderTable';
import { InsiderAccuracyPanel, type PanelInsider } from './InsiderAccuracyPanel';
import { OptionsFlow } from './OptionsFlow';
import { XIcon, StarIcon, UsersIcon } from '@/components/UI/icons';
import { formatUSD, formatDate, accuracyColor, formatPercent } from '@/lib/format';
import { useSwipeToDismiss } from '@/hooks/useSwipeToDismiss';

function getTradingViewSymbol(ticker: string): string {
  const base = ticker.replace('$', '').split('-')[0].trim().toUpperCase();
  const cryptoMap: Record<string, string> = {
    'BTC': 'BTCUSD',
    'ETH': 'ETHUSD',
    'SOL': 'SOLUSD',
    'ADA': 'ADAUSD',
    'XRP': 'XRPUSD',
    'DOGE': 'DOGEUSD',
    'DOT': 'DOTUSD',
    'LTC': 'LTCUSD',
    'LINK': 'LINKUSD',
    'AVAX': 'AVAXUSD',
    'SHIB': 'SHIBUSD',
    'BNB': 'BNBUSD'
  };
  return cryptoMap[base] || base;
}

function TradingViewChart({ ticker, theme }: { ticker: string; theme: string }) {
  const { t } = useI18n();
  const symbol = getTradingViewSymbol(ticker);
  return (
    <div 
      className="w-full overflow-hidden rounded-xl"
      style={{ 
        height: '550px',
        border: '1px solid var(--border-glass)',
        background: 'var(--bg-glass)',
        boxShadow: 'var(--shadow-glass)'
      }}
    >
      <iframe
        src={`https://s.tradingview.com/widgetembed/?symbol=${symbol}&theme=${theme}&style=1&timezone=exchange&interval=D&withdateranges=1&details=1&hide_side_toolbar=0&allow_symbol_change=1`}
        style={{ width: '100%', height: '100%', border: 'none' }}
        title={t('modal.chartFor', { symbol })}
      />
    </div>
  );
}

function InfoCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}>
      <div className="text-xs uppercase tracking-wide text-secondary">{label}</div>
      <div className="text-sm font-semibold">{children}</div>
    </div>
  );
}

export function SignalModal() {
  const theme = useStore((s) => s.theme);
  const selectedTicker = useStore((s) => s.selectedTicker);
  const chartOnly = useStore((s) => s.chartOnly);
  const closeSignal = useStore((s) => s.closeSignal);
  const storeSignals = useStore((s) => s.signals);
  const fetchTrackRecord = useStore((s) => s.fetchTrackRecord);
  const loadSignals = useStore((s) => s.loadSignals);
  const { isWatched, toggleWatch } = useWatchlist();
  const [signal, setSignal] = useState<Signal | null>(null);
  const [loadingSignal, setLoadingSignal] = useState(true);
  const { t, language } = useI18n();
  const [records, setRecords] = useState<Record<string, InsiderTrackRecord>>({});
  const [trLoading, setTrLoading] = useState(false);
  const fetchedRef = useRef<string | null>(null);
  // Same gesture the Sheet primitive uses (shared hook), so the detail closes by
  // swipe as well as Escape / tap-outside / Back.
  const { offset: dragY, dragging, handlers: swipe } = useSwipeToDismiss(() => closeSignal());

  const [localEarningsDate, setLocalEarningsDate] = useState<string | null>(null);
  const [localDaysToEarnings, setLocalDaysToEarnings] = useState<number | null>(null);
  const [localEarningsTiming, setLocalEarningsTiming] = useState<string | null>(null);
  const [performance, setPerformance] = useState<SignalPerformance | null>(null);
  const [tickerNews, setTickerNews] = useState<NewsItem[]>([]);

  useEffect(() => {
    if (!selectedTicker) {
      setSignal(null);
      setLoadingSignal(false);
      return;
    }
    if (chartOnly) {
      setSignal(null);
      setLoadingSignal(false);
      return;
    }
    setLoadingSignal(true);
    const local = storeSignals.find((s) => s.ticker === selectedTicker);
    if (local) {
      setSignal(local);
      setLoadingSignal(false);
    } else {
      setSignal(null);
    }
    let active = true;
    api.signals
      .getByTicker(selectedTicker)
      .then((s) => {
        if (active) {
          if (s) {
            setSignal(s);
          } else {
            setSignal(null);
          }
          setLoadingSignal(false);
        }
      })
      .catch(() => {
        if (active) {
          setSignal(null);
          setLoadingSignal(false);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTicker, chartOnly]);

  useEffect(() => {
    if (signal) {
      setLocalEarningsDate(signal.earningsDate ?? null);
      setLocalDaysToEarnings(signal.daysToEarnings ?? null);
      setLocalEarningsTiming(signal.earningsTiming ?? null);
    } else {
      setLocalEarningsDate(null);
      setLocalDaysToEarnings(null);
      setLocalEarningsTiming(null);
    }
  }, [signal]);

  useEffect(() => {
    if (!signal || signal.earningsDate) return;
    let active = true;
    api.earnings
      .fetch(signal.ticker)
      .then((res) => {
        if (active && res.earningsDate) {
          setLocalEarningsDate(res.earningsDate);
          if (res.daysToEarnings !== undefined) setLocalDaysToEarnings(res.daysToEarnings ?? null);
          if (res.earningsTiming !== undefined) setLocalEarningsTiming(res.earningsTiming ?? null);
          void loadSignals();
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [signal, loadSignals]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSignal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSignal]);

  // Feature 2 + 7 — "follow this signal" P&L and ticker-tagged news.
  useEffect(() => {
    if (!selectedTicker || chartOnly) {
      setPerformance(null);
      setTickerNews([]);
      return;
    }
    let active = true;
    api.signals.getPerformance(selectedTicker).then((p) => active && setPerformance(p)).catch(() => undefined);
    api.news.getForTicker(selectedTicker).then((n) => active && setTickerNews(n)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedTicker, chartOnly]);

  // Unique scoring-eligible insiders on this signal (for track records).
  const insiders = useMemo<(PanelInsider & { url?: string; role?: string })[]>(() => {
    if (!signal) return [];
    const map = new Map<string, PanelInsider & { url?: string; role?: string }>();
    for (const t of signal.rawTrades) {
      if (classifyTransaction(t.transactionType).modifier <= 0) continue;
      const key = normalizeInsiderName(t.insiderName);
      if (!key || map.has(key)) continue;
      map.set(key, { name: t.insiderName, role: t.role, key, url: t.insiderUrl });
    }
    return [...map.values()];
  }, [signal]);

  // Feature 6 — lazily fetch track records once per ticker.
  useEffect(() => {
    if (!signal) {
      fetchedRef.current = null;
      setRecords({});
      setTrLoading(false);
      return;
    }
    if (fetchedRef.current === signal.ticker) return;
    const ticker = signal.ticker;
    fetchedRef.current = ticker;
    setRecords({});
    if (insiders.length === 0) return;
    setTrLoading(true);
    void Promise.all(
      insiders.map(async (ins) => {
        const fallbackRec: InsiderTrackRecord = {
          insiderName: ins.name,
          insiderRole: ins.role || null,
          totalTrades: 0,
          profitable3m: 0,
          profitable6m: 0,
          accuracy3m: 0,
          accuracy6m: 0,
          avgReturn3m: 0,
          lastUpdated: new Date().toISOString(),
          recentTrades: [],
          error: t('acc.unavailable'),
        };
        const rec = await fetchTrackRecord(ins.name, ins.role, ins.url).catch(() => null);
        if (fetchedRef.current === ticker) {
          setRecords((prev) => ({ ...prev, [ins.key]: rec || fallbackRec }));
        }
      }),
    ).finally(() => {
      if (fetchedRef.current === ticker) {
        setTrLoading(false);
      }
    });
  }, [signal, insiders, fetchTrackRecord]);

  const best = useMemo(() => {
    let top: InsiderTrackRecord | null = null;
    for (const ins of insiders) {
      const rec = records[ins.key];
      if (rec && rec.totalTrades > 0 && (!top || rec.accuracy3m > top.accuracy3m)) top = rec;
    }
    return top;
  }, [records, insiders]);

  if (!selectedTicker) return null;
  const watched = isWatched(selectedTicker);
  const earningsFill =
    localDaysToEarnings != null && localDaysToEarnings >= 0 && localDaysToEarnings <= 30
      ? (30 - localDaysToEarnings) / 30
      : 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)' }}
      onClick={closeSignal}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={selectedTicker}
        // Mobile: a bottom sheet that owns the full width and nearly the full
        // height — a centred dialog wasted horizontal space on a 360px screen and
        // squeezed body text into 1–2 word columns (AUDIT B2).
        className="glass animate-scale-in flex max-h-[94svh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl sm:max-h-[88vh] sm:rounded-2xl"
        style={{
          paddingBottom: 'var(--sa-bottom)',
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? 'none' : 'transform 280ms cubic-bezier(0.32,0.72,0,1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle — the swipe surface on mobile; the sheet also closes via
            Escape, tap-outside and the Back gesture. */}
        <div className="flex shrink-0 cursor-grab touch-none flex-col items-center pb-1 pt-2.5 sm:hidden" {...swipe}>
          <span className="h-1 w-10 rounded-full" style={{ background: 'var(--border-active)' }} />
        </div>

        {/* Header */}
        <div
          // On a phone the gauge, the text column and two buttons fought over
          // 360px, leaving the text ~90px wide and letting the watchlist button
          // overlap it (AUDIT B2). Close stays pinned; the rest stacks.
          className="relative flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6 sm:py-5"
          style={{ borderBottom: '1px solid var(--border-glass)' }}
        >
          <div className="flex items-center gap-3 pr-12 sm:contents">
            {!chartOnly && signal && <ScoreGauge score={signal.score} size={64} stroke={7} />}
            <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h2 className="text-xl font-extrabold font-mono-terminal sm:text-2xl">{selectedTicker}</h2>
              {!chartOnly && signal?.bigPlayer && (
                <span
                  className="inline-flex select-none items-center gap-0.5 rounded px-2 py-0.5 text-xs font-extrabold uppercase "
                  style={{
                    background: 'var(--bg-glass-hover)',
                    color: 'var(--accent-yellow)',
                    border: '1px solid var(--border-glass)',
                    fontWeight: 650,
                    letterSpacing: '0.02em',
                  }}
                >
                   {t('card.bigPlayer')}
                </span>
              )}
              {!chartOnly && signal && <ConvictionBadge level={signal.convictionLevel} />}
              {!chartOnly && signal?.breakdown?.politicianComboTier ? (
                <PoliticianComboBadge tier={signal.breakdown.politicianComboTier} />
              ) : (
                !chartOnly && signal?.comboSignal && <ComboBadge pulse={false} />
              )}
            </div>
            <p className="truncate text-sm text-secondary">
              {/* `&&` binds tighter than `||`, so a missing companyName used to fall
                  through to the chart-only placeholder ("AMZN Asset Chart") even in
                  the full detail view. Keep the placeholder for chart-only mode only. */}
              {chartOnly ? t('modal.assetChart', { ticker: selectedTicker }) : signal?.companyName || selectedTicker}
              {!chartOnly && signal?.sector ? ` · ${signal.sector}` : ''}
            </p>
            {!chartOnly && signal && (
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-secondary sm:text-xs">
                <span className="inline-flex items-center gap-1">
                  <UsersIcon size={13} />{' '}
                  {t(signal.insiderCount === 1 ? 'card.insiderOne' : 'card.insiderMany', { count: signal.insiderCount })}
                </span>
                <span>{t('modal.bought', { amount: formatUSD(signal.totalDollarVolume) })}</span>
                {best && (
                  <span style={{ color: accuracyColor(best.accuracy3m) }}>
                    {t('modal.topInsider', {
                      pct: Math.round(best.accuracy3m * 100),
                      n: best.totalTrades,
                    })}
                  </span>
                )}
              </p>
            )}
            </div>
          </div>

          <button
            className="btn w-full sm:w-auto"
            style={{ minHeight: 44, ...(watched ? { color: 'var(--accent-yellow)' } : {}) }}
            onClick={() => void toggleWatch(selectedTicker)}
          >
            <StarIcon size={16} filled={watched} />
            {watched ? t('modal.watching') : t('card.addToWatchlist')}
          </button>
          {/* Absolute on mobile so it never competes for the header's width. */}
          <button
            className="icon-btn absolute right-4 top-4 sm:static"
            onClick={closeSignal}
            aria-label={t('common.close')}
          >
            <XIcon size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-7 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          {chartOnly ? (
            <TradingViewChart ticker={selectedTicker} theme={theme} />
          ) : loadingSignal ? (
            <div className="py-16 flex flex-col items-center justify-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent-blue)] border-t-transparent" />
              <span className="text-xs text-secondary font-medium">{t('modal.loadingSignal')}</span>
            </div>
          ) : signal ? (
            <>
              {/* Congressional MEGA_SIGNAL — unmissable pulsing banner. */}
              {signal.breakdown?.politicianComboTier === 'MEGA_SIGNAL' && <MegaSignalBanner />}

              {/* Politician combo tiers (purple / blue) — replace the orange COMBO banner. */}
              {signal.breakdown?.politicianComboTier === 'POLITICIAN_INSIDER' && (
                <div
                  className="rounded-xl px-4 py-3 text-sm font-semibold"
                  style={{
                    color: 'var(--accent-purple)',
                    background: 'color-mix(in srgb, var(--accent-purple) 14%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-purple) 35%, transparent)',
                  }}
                >
                  {t('modal.polInsiderBanner')}
                </div>
              )}
              {signal.breakdown?.politicianComboTier === 'POLITICIAN_OPTIONS' && (
                <div
                  className="rounded-xl px-4 py-3 text-sm font-semibold"
                  style={{
                    color: 'var(--accent-blue)',
                    background: 'color-mix(in srgb, var(--accent-blue) 14%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent)',
                  }}
                >
                  {t('modal.polOptionsBanner')}
                </div>
              )}

              {/* Feature 4 — regular combo banner (only when no politician tier fired). */}
              {signal.comboSignal && !signal.breakdown?.politicianComboTier && (
                <div
                  className="rounded-xl px-4 py-3 text-sm font-semibold"
                  style={{
                    color: 'var(--accent-blue)',
                    background: 'color-mix(in srgb, var(--accent-blue) 14%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent)',
                  }}
                >
                   {t('modal.comboDetected')}
                </div>
              )}

              {/* Feature 13 — net bearish options flow */}
              {(signal.breakdown?.optionsScore ?? 0) < 0 && (
                <div
                  className="rounded-xl px-4 py-3 text-sm font-semibold"
                  style={{
                    color: 'var(--accent-red)',
                    background: 'color-mix(in srgb, var(--accent-red) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)',
                  }}
                >
                   {t('modal.netBearish')}
                </div>
              )}

              {/* Features 1 + 5 — dates & earnings */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <InfoCell label={t('modal.tradeDate')}>{formatDate(signal.tradeDate, language)}</InfoCell>
                <InfoCell label={t('modal.filingDate')}>
                  <span className="inline-flex items-center gap-1">
                    {formatDate(signal.filingDate, language)}
                    {signal.lateFiling && (
                      <span className="neutral-badge">{t('modal.lateFiling')}</span>
                    )}
                  </span>
                </InfoCell>
                <InfoCell label={t('modal.earnings')}>
                  {localEarningsDate ? (
                    <div>
                       <div>
                         {formatDate(localEarningsDate, language)}
                         {localEarningsTiming ? ` · ${localEarningsTiming}` : ''}
                         {localDaysToEarnings != null && localDaysToEarnings >= 0 ? ` (${localDaysToEarnings}d)` : ''}
                       </div>
                       {earningsFill > 0 && (
                         <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border-glass)' }}>
                           <div className="h-full rounded-full" style={{ width: `${earningsFill * 100}%`, background: 'var(--accent-yellow)' }} />
                         </div>
                       )}
                    </div>
                  ) : (
                    <span className="text-secondary">—</span>
                  )}
                </InfoCell>
              </div>

              {/* Feature 2 — "follow this signal" P&L since the signal first appeared */}
              {performance && performance.returnPct != null && (
                <div
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-4 py-3 text-sm"
                  style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}
                >
                  <span className="text-secondary">{t('modal.sinceSignal', { date: formatDate(performance.sinceDate, language) })}</span>
                  <span
                    className="font-bold tabular-nums"
                    style={{ color: (performance.returnPct ?? 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
                  >
                    {formatPercent(performance.returnPct)}
                  </span>
                  {performance.alphaPct != null && (
                    <span
                      className="text-xs tabular-nums"
                      style={{ color: performance.alphaPct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
                    >
                      {formatPercent(performance.alphaPct)} vs S&P
                    </span>
                  )}
                </div>
              )}

              <FairValuePanel ticker={selectedTicker} />

              {/* TradingView Chart */}
              <TradingViewChart ticker={selectedTicker} theme={theme} />

              <ScoreBreakdown
                breakdown={signal.breakdown}
                insiderFlow={signal.insiderFlow}
                stats={signal.stats}
                politicianTrades={signal.politicianTrades}
                rawTrades={signal.rawTrades}
              />
              <AlertFairValuePanel value={signal.breakdown.fairValue} />
              <InsiderAccuracyPanel insiders={insiders} records={records} loading={trLoading} />
              <InsiderTable trades={signal.rawTrades} trackRecords={records} loading={trLoading} />
              <OptionsFlow options={signal.optionsActivity} />

              {/* Feature 7 — news mentioning this ticker */}
              {tickerNews.length > 0 && (
                <section>
                  <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">{t('modal.recentMentions')}</h3>
                  <div className="flex flex-col gap-2">
                    {tickerNews.slice(0, 5).map((n) => (
                      <a
                        key={n.id}
                        href={n.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-xl px-4 py-2.5 text-sm hover:opacity-80"
                        style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)' }}
                      >
                        <div>{displayText(n.text)}</div>
                        <div className="mt-1 text-[11px] text-secondary">{formatDate(n.timestamp, language)} · @WhaleInsider</div>
                      </a>
                    ))}
                  </div>
                </section>
              )}
            </>
          ) : (
            <TradingViewChart ticker={selectedTicker} theme={theme} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
