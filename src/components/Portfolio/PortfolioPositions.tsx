import { useState } from 'react';
import { GlassCard } from '@/components/UI/GlassCard';
import { useI18n } from '@/hooks/useI18n';
import { useStore } from '@/store/useStore';
import { formatDate, formatPrice } from '@/lib/format';
import type { PortfolioClosedPosition, PortfolioExitReason, PortfolioOpenPosition } from '@/types';
import type { TKey } from '@/lib/i18n';

/**
 * Open and closed positions.
 *
 * Every trade is listed, winners and losers alike, with the exit reason spelled
 * out — a table that only showed the good ones would make the aggregate figures
 * above it unverifiable.
 */

const PAGE = 12;

const pct = (v: number | null | undefined, digits = 2): string =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;

const sign = (v: number | null | undefined): string | undefined =>
  v == null ? undefined : v >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

const EXIT_LABELS: Record<PortfolioExitReason, TKey> = {
  take_profit: 'pf.exit.take_profit',
  stop_loss: 'pf.exit.stop_loss',
  trailing: 'pf.exit.trailing',
  time: 'pf.exit.time',
  data_missing: 'pf.exit.data_missing',
};

const EXIT_COLORS: Record<PortfolioExitReason, string> = {
  take_profit: 'var(--accent-green)',
  stop_loss: 'var(--accent-red)',
  trailing: 'var(--accent-yellow)',
  time: 'var(--text-secondary)',
  data_missing: 'var(--text-secondary)',
};

function ExitBadge({ reason }: { reason: PortfolioExitReason }) {
  const { t, language } = useI18n();
  const color = EXIT_COLORS[reason];
  return (
    <span
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      {t(EXIT_LABELS[reason])}
    </span>
  );
}

function TickerButton({ ticker }: { ticker: string }) {
  const openSignal = useStore((s) => s.openSignal);
  return (
    <button
      type="button"
      className="font-mono-terminal font-bold tabular-nums hover:underline"
      onClick={() => openSignal(ticker)}
    >
      {ticker}
    </button>
  );
}

function MoreButton({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  const { t, language } = useI18n();
  if (total <= PAGE) return null;
  return (
    <button type="button" className="btn mt-3 w-full" onClick={onToggle}>
      {expanded ? t('pf.showLess') : t('pf.showMore', { n: total })}
    </button>
  );
}

export function OpenPositionsTable({ positions }: { positions: PortfolioOpenPosition[] }) {
  const { t, language } = useI18n();
  return (
    <GlassCard className="p-4 lg:p-6">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">
        {t('pf.open.title')} {positions.length > 0 && <span className="tabular-nums">({positions.length})</span>}
      </h3>
      {positions.length === 0 ? (
        <p className="py-4 text-sm text-secondary">{t('pf.open.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-secondary">
                <th className="py-1.5 pr-3 font-semibold">{t('pf.col.ticker')}</th>
                <th className="py-1.5 pr-3 font-semibold">{t('pf.col.entryDate')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.score')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.weight')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.entryPrice')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.price')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.unrealized')}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.hold')}</th>
                <th className="py-1.5 text-right font-semibold">{t('pf.col.barrier')}</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={`${p.ticker}-${p.entryDate}`} style={{ borderTop: '1px solid var(--border-glass)' }}>
                  <td className="py-2 pr-3">
                    <TickerButton ticker={p.ticker} />
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-secondary">{formatDate(p.entryDate, language)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p.entryScore.toFixed(1)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-secondary">{(p.weight * 100).toFixed(1)}%</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatPrice(p.entryPrice)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatPrice(p.lastPrice)}
                    {p.priceStale && (
                      <div className="text-xs text-secondary">
                        {p.priceAsOf ? t('pf.price.stale', { date: formatDate(p.priceAsOf, language) }) : t('pf.price.unavailable')}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums" style={{ color: sign(p.unrealizedPct) }}>
                    {pct(p.unrealizedPct)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-secondary">
                    {t('pf.trades.days', { n: p.holdDays })}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {p.nearestBarrier ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="tabular-nums text-secondary">{pct(p.nearestBarrierPct, 1)}</span>
                        <ExitBadge reason={p.nearestBarrier} />
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  );
}

export function ClosedTradesTable({ trades }: { trades: PortfolioClosedPosition[] }) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? trades : trades.slice(0, PAGE);

  return (
    <GlassCard className="p-4 lg:p-6">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">
        {t('pf.closed.title')} {trades.length > 0 && <span className="tabular-nums">({trades.length})</span>}
      </h3>
      {trades.length === 0 ? (
        <p className="py-4 text-sm text-secondary">{t('pf.closed.none')}</p>
      ) : (
        <>
          {/* Eleven columns need ~1094px and the card offers ~1066px at 1440px,
              so this one scrolls the last ~30px. The gutters come from the
              app-wide `th, td { padding: 10px 14px !important }` in globals.css,
              not from these classes — narrowing it here would only make this
              table disagree with every other one. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-secondary">
                  <th className="py-1.5 pr-3 font-semibold">{t('pf.col.ticker')}</th>
                  <th className="py-1.5 pr-3 font-semibold">{t('pf.col.entryDate')}</th>
                  <th className="py-1.5 pr-3 font-semibold">{t('pf.col.exitDate')}</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.score')}</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.entryPrice')}</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.exitPrice')}</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.return')}</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.realized')}</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.alpha')}</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">{t('pf.col.hold')}</th>
                  <th className="py-1.5 text-right font-semibold">{t('pf.col.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={`${p.ticker}-${p.entryDate}`} style={{ borderTop: '1px solid var(--border-glass)' }}>
                    <td className="py-2 pr-3">
                      <TickerButton ticker={p.ticker} />
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-secondary">{formatDate(p.entryDate, language)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-secondary">{formatDate(p.exitDate, language)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{p.entryScore.toFixed(1)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatPrice(p.entryPrice)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatPrice(p.exitPrice)}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums" style={{ color: sign(p.returnPct) }}>
                      {pct(p.returnPct)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums" style={{ color: sign(p.realizedPnl) }}>
                      {p.realizedPnl == null ? '—' : `${p.realizedPnl >= 0 ? '+' : '−'}${formatPrice(Math.abs(p.realizedPnl))}`}
                    </td>
                    {/* The benchmark over EXACTLY this trade's holding period —
                        the column that survives cash drag and window luck. */}
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums" style={{ color: sign(p.tradeAlpha) }}>
                      {pct(p.tradeAlpha)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-secondary">
                      {t('pf.trades.days', { n: p.holdDays })}
                    </td>
                    <td className="py-2 text-right">{p.exitReason && <ExitBadge reason={p.exitReason} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MoreButton total={trades.length} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        </>
      )}
    </GlassCard>
  );
}
