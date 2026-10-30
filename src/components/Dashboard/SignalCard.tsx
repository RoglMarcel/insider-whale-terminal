import { summarizeInsiderTrades, mergeInsiderSaleVolume } from '@/lib/insider-summary';
import { localizeRole } from '@/lib/signal-language';
import type { MouseEvent } from 'react';
import { type Signal, daysBetween } from '@/types';
import { GlassCard } from '@/components/UI/GlassCard';
import { ScoreGauge } from '@/components/UI/ScoreGauge';
import { ConvictionBadge } from '@/components/UI/ConvictionBadge';
import { FreshnessBadge } from '@/components/UI/FreshnessBadge';
import { EarningsChip } from '@/components/UI/EarningsChip';
import { ComboBadge } from '@/components/UI/ComboBadge';
import { PoliticianComboBadge, MegaSignalBanner, PoliticianCountBadge } from '@/components/UI/PoliticianBadges';
import { StarIcon, UsersIcon, ActivityIcon } from '@/components/UI/icons';
import { useStore } from '@/store/useStore';
import { useWatchlist } from '@/hooks/useWatchlist';
import { formatUSD, formatPrice, formatCompact, confidenceColor } from '@/lib/format';
import { useI18n } from '@/hooks/useI18n';
import { AlertFairValue } from '@/components/UI/AlertFairValue';

function DetailRow({ label, value, isMono = false }: { label: string; value: string; isMono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 text-[13px] leading-none lg:text-xs">
      <span className="text-secondary min-w-0 flex-1 break-words leading-snug">{label}</span>
      <span className={`truncate font-semibold text-right shrink-0 max-w-[45%] ${isMono ? 'font-mono-terminal' : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}

/** Small pill used for the context row (net flow, short interest, drawdown, etc.). */
function Pill({ text, color, title }: { text: string; color: string; title?: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-md px-2 py-1 text-xs font-bold"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
      title={title ?? text}
    >
      {text}
    </span>
  );
}

export function SignalCard({ signal }: { signal: Signal }) {
  const openSignal = useStore((s) => s.openSignal);
  const { isWatched, toggleWatch } = useWatchlist();
  const { t, language } = useI18n();
  const watched = isWatched(signal.ticker);

  const insider = summarizeInsiderTrades(signal.rawTrades ?? []);
  const avgPrice = insider.saleOnly ? insider.salePrice : insider.buyPrice;
  const displayVolume = insider.saleOnly ? insider.sells : insider.buys;
  const displayRole = insider.role;

  const topOption = signal.optionsActivity?.[0];
  const ageDays = daysBetween(signal.tradeDate) ?? signal.breakdown.signalAgeDays;
  const confidence = signal.breakdown?.confidence;

  // ── Context pills (only render when the backend actually has the data) ──
  const recent = summarizeInsiderTrades(signal.rawTrades ?? [], Date.now(), 90);
  const recordedFlow = signal.insiderFlow;
  const flow = recordedFlow || recent.buys > 0 || recent.sells > 0
    ? { buys: recordedFlow?.buys ?? recent.buys, sells: mergeInsiderSaleVolume(recordedFlow?.sells ?? 0, recent.sells), form144: recordedFlow?.form144 ?? 0 }
    : undefined;
  const stats = signal.stats;
  const netFlow = flow ? flow.buys - flow.sells : undefined;
  const netFlowColor =
    netFlow == null ? 'var(--text-secondary)' : netFlow > 0 ? 'var(--accent-green)' : netFlow < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';
  const dd = stats?.pctFrom52wHigh;
  const shortPct = stats?.shortPctFloat;
  const adv = stats?.avgDollarVolume;

  // ── Congressional signal (additive — absent unless the backend has data) ──
  const politicianTrades = signal.politicianTrades ?? [];
  const politicianCount = new Set(politicianTrades.map((t) => t.politician.toLowerCase())).size;
  const hasPolitician = (signal.politicianScore ?? 0) > 0 && politicianCount > 0;
  const tier = signal.breakdown?.politicianComboTier ?? null;
  const isMega = tier === 'MEGA_SIGNAL';

  const onStar = (e: MouseEvent) => {
    e.stopPropagation();
    void toggleWatch(signal.ticker);
  };

  const cardBorderStyle = isMega
    ? { border: '1px solid color-mix(in srgb, var(--accent-red) 60%, transparent)' }
    : tier === 'POLITICIAN_INSIDER'
      ? { border: '1px solid color-mix(in srgb, var(--accent-purple) 55%, transparent)' }
      : tier === 'POLITICIAN_OPTIONS'
        ? { border: '1px solid color-mix(in srgb, var(--accent-blue) 55%, transparent)' }
        : signal.comboSignal
          ? { border: '1px solid color-mix(in srgb, var(--accent-blue) 50%, transparent)' }
          : signal.bigPlayer
            ? { border: '1px solid color-mix(in srgb, var(--accent-yellow) 40%, var(--border-glass))' }
            : undefined;

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2">
      {/* MEGA_SIGNAL — full-width pulsing banner above the card, unmissable. */}


      <GlassCard
        hover
        onClick={() => openSignal(signal.ticker)}
        role="button"
        tabIndex={0}
        aria-label={signal.ticker}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSignal(signal.ticker); } }}
        className="signal-card relative flex h-full w-full min-w-0 flex-1 flex-col gap-3 p-4 lg:gap-4 lg:p-5"
        style={cardBorderStyle}
      >
        {isMega && <MegaSignalBanner />}
        {/* Combo badge — a politician tier REPLACES the orange COMBO badge. */}
        {tier ? (
          <PoliticianComboBadge tier={tier} className="absolute -right-2 -top-2 shadow-lg" />
        ) : signal.comboSignal ? (
          <ComboBadge className="absolute -right-2 -top-2 shadow-lg" />
        ) : null}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xl font-extrabold leading-tight font-mono-terminal">{signal.ticker}</div>
            {signal.bigPlayer && (
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
          </div>
          <div className="truncate text-[13px] text-secondary lg:text-xs" title={signal.companyName ?? ''}>
            {signal.companyName || '—'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {confidence != null && (
            <span
              className="inline-flex select-none rounded-md px-2 py-1 text-xs font-bold tabular-nums"
              style={{ color: confidenceColor(confidence), background: `color-mix(in srgb, ${confidenceColor(confidence)} 12%, transparent)` }}
              title={t('card.confidenceTitle', { pct: Math.round(confidence) })}
            >
              {Math.round(confidence)}%
            </span>
          )}
          <button
            className="icon-btn h-11 w-11 shrink-0 lg:h-9 lg:w-9"
            onClick={onStar}
            title={watched ? t('card.removeFromWatchlist') : t('card.addToWatchlist')}
            style={watched ? { color: 'var(--accent-yellow)' } : undefined}
          >
            <StarIcon size={16} filled={watched} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <ScoreGauge score={signal.score} size={88} stroke={8} />
        <div className="flex h-[88px] min-w-0 flex-1 flex-col justify-between">
          <div className="flex shrink-0 flex-row flex-wrap items-center gap-1">
            <ConvictionBadge level={signal.convictionLevel} className="shrink-0 px-2 py-1 text-xs" />
            <FreshnessBadge ageDays={ageDays} className="shrink-0 px-2 py-1 text-xs" />
            <EarningsChip days={signal.daysToEarnings} timing={signal.earningsTiming} className="shrink-0 px-2 py-1 text-xs" />
            {hasPolitician && <PoliticianCountBadge count={politicianCount} className="shrink-0" />}
          </div>
          <DetailRow label={t('card.role')} value={localizeRole(displayRole, language)} />
          <DetailRow label={t(insider.saleOnly ? 'card.salePrice' : 'card.price')} value={avgPrice ? formatPrice(avgPrice) : '—'} isMono />
          <DetailRow label={t(insider.saleOnly ? 'card.saleVolume' : 'card.buyVolume')} value={displayVolume > 0 ? formatUSD(displayVolume) : '—'} isMono />
        </div>
      </div>

      {/* Context pills — net flow, drawdown, short interest, liquidity. Each only
          renders when the backend has the datum; the row hides entirely if none. */}
      {(netFlow != null || dd != null || (shortPct != null && shortPct >= 20) || (adv != null && adv < 500_000)) && (
        <div className="signal-context flex flex-wrap items-start gap-1.5">
          {netFlow != null && (
            <Pill
              color={netFlowColor}
              text={`NET ${netFlow >= 0 ? '+' : '−'}${formatUSD(Math.abs(netFlow))}`}
              title={
                t('card.netFlowTitle', {
                  buys: formatUSD(flow!.buys),
                  sells: formatUSD(flow!.sells),
                }) + (flow!.form144 > 0 ? ` · ${t('card.form144', { n: flow!.form144 })}` : '')
              }
            />
          )}
          {dd != null && (
            <Pill
              color={dd <= -40 ? 'var(--accent-green)' : 'var(--text-secondary)'}
              text={t('card.from52wHigh', { pct: Math.round(dd) })}
              title={dd <= -40 ? t('card.deepValueTitle') : t('card.from52wHighTitle')}
            />
          )}
          {shortPct != null && shortPct >= 20 && (
            <Pill color="#ff9f0a" text={` SI ${shortPct.toFixed(0)}%`} title={t('card.shortInterestTitle', { pct: shortPct.toFixed(1) })} />
          )}
          {adv != null && adv < 500_000 && (
            <Pill color="var(--accent-red)" text={` ${t('card.lowLiquidity')}`} title={t('card.lowLiquidityTitle', { amount: formatUSD(adv) })} />
          )}
        </div>
      )}

      <AlertFairValue ticker={signal.ticker} recorded={signal.breakdown.fairValue} />
      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--border-glass)' }}>
        <span className="inline-flex items-center gap-1.5 text-sm text-secondary">
          <UsersIcon size={15} />
          {t(insider.count === 1 ? 'card.insiderOne' : 'card.insiderMany', { count: insider.count })}
        </span>
        {topOption ? (
          <span
            className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold font-mono-terminal"
            style={{ color: topOption.sentiment === 'bullish' ? 'var(--accent-green)' : 'var(--accent-red)' }}
          >
            <ActivityIcon size={15} className="shrink-0" />
            {formatUSD(topOption.notional)} {t(topOption.type === 'call' ? 'card.calls' : 'card.puts')}
          </span>
        ) : (
          <span className="text-sm text-secondary">{t('card.noOptionsFlow')}</span>
        )}
      </div>
      </GlassCard>
    </div>
  );
}
