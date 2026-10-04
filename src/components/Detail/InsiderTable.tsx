import { localizeRole, localizeTransactionLabel } from '@/lib/signal-language';
import { useState } from 'react';
import { ExternalLinkIcon } from '@/components/UI/icons';
import { useI18n } from '@/hooks/useI18n';
import { createPortal } from 'react-dom';
import { type RawInsiderTrade, type InsiderTrackRecord, classifyTransaction, normalizeInsiderName } from '@/types';
import { formatUSD, formatNumber, formatDate, formatPrice, formatPercent, accuracyColor } from '@/lib/format';

function tierColor(tier: 'strong' | 'reduced' | 'excluded'): string {
  if (tier === 'strong') return 'var(--accent-green)';
  if (tier === 'reduced') return 'var(--accent-yellow)';
  return 'var(--text-secondary)';
}

function TrackRecordModal({ record, onClose }: { record: InsiderTrackRecord; onClose: () => void }) {
  const { t: tr, language } = useI18n();
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.45)', backdropFilter: 'blur(5px)' }}
      onClick={onClose}
    >
      <div
        className="glass animate-scale-in relative w-full max-w-md p-6 text-left shadow-2xl"
        style={{ background: 'var(--bg-glass-hover)', border: '1px solid var(--border-glass)', backdropFilter: 'blur(30px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-secondary hover:text-primary transition-colors p-1.5 rounded-lg hover:bg-white/10"
          aria-label={tr('tbl.closeTrackRecord')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>

        <h3 className="mb-4 pr-8 text-sm font-extrabold uppercase tracking-wider text-secondary">
          {record.insiderName} — {tr('tbl.historicalTrades')}
        </h3>

        {record.error ? (
          <div className="py-6 text-center text-sm text-secondary">{tr('acc.unavailable')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <thead>
                <tr className="text-left text-secondary border-none">
                  <th className="py-2 px-1 font-semibold bg-transparent text-[10px]" style={{ borderBottom: '1px solid var(--border-glass)' }}>{tr('tbl.date')}</th>
                  <th className="py-2 px-1 font-semibold bg-transparent text-[10px]" style={{ borderBottom: '1px solid var(--border-glass)' }}>{tr('tbl.ticker')}</th>
                  <th className="py-2 px-1 text-right font-semibold bg-transparent text-[10px]" style={{ borderBottom: '1px solid var(--border-glass)' }}>{tr('tbl.amount')}</th>
                  <th className="py-2 px-1 text-right font-semibold bg-transparent text-[10px]" style={{ borderBottom: '1px solid var(--border-glass)' }}>{tr('tbl.buyPrice')}</th>
                  <th className="py-2 px-1 text-right font-semibold bg-transparent text-[10px]" title={tr('tbl.3mVsSpTitle')} style={{ borderBottom: '1px solid var(--border-glass)' }}>{tr('tbl.3mVsSp')}</th>
                  <th className="py-2 px-1 text-right font-semibold bg-transparent text-[10px]" title={tr('tbl.6mVsSpTitle')} style={{ borderBottom: '1px solid var(--border-glass)' }}>{tr('tbl.6mVsSp')}</th>
                </tr>
              </thead>
              <tbody>
                {record.recentTrades.map((t, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-glass)' }}>
                    <td className="py-2.5 px-1 text-secondary whitespace-nowrap">{formatDate(t.tradeDate, language)}</td>
                    <td className="py-2.5 px-1 font-semibold">{t.ticker}</td>
                    <td className="py-2.5 px-1 text-right tabular-nums">
                      {formatUSD(t.value ?? (t.shares && t.purchasePrice ? t.shares * t.purchasePrice : undefined))}
                    </td>
                    <td className="py-2.5 px-1 text-right tabular-nums">{formatPrice(t.purchasePrice)}</td>
                    <td
                      className="py-2.5 px-1 text-right font-bold tabular-nums"
                      style={{ color: (t.return3m ?? 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
                    >
                      {formatPercent(t.return3m)}
                    </td>
                    <td className="py-2.5 px-1 text-right text-secondary tabular-nums">
                      {t.wasProfitable6m == null ? '—' : t.wasProfitable6m ? tr('common.yes') : tr('common.no')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function TrackRecordCell({
  record,
  loading,
  open,
  onToggle,
}: {
  record?: InsiderTrackRecord;
  loading: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t: tr } = useI18n();
  if (loading && !record) return <span className="skeleton inline-block h-4 w-16" />;
  if (!record || record.totalTrades === 0) return <span className="text-secondary">—</span>;
  const pct = Math.round(record.accuracy3m * 100);
  const color = accuracyColor(record.accuracy3m);
  return (
    <div className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="inline-flex items-center font-semibold tabular-nums hover:underline"
        style={{ color, minHeight: 44 }}
        title={tr('tbl.trackRecordTitle', { hit: record.profitable3m, total: record.totalTrades })}
      >
        {record.profitable3m}/{record.totalTrades}  ({pct}%)
      </button>
      {open && <TrackRecordModal record={record} onClose={onToggle} />}
    </div>
  );
}

export function InsiderTable({
  trades,
  trackRecords = {},
  loading = false,
}: {
  trades: RawInsiderTrade[];
  trackRecords?: Record<string, InsiderTrackRecord>;
  loading?: boolean;
}) {
  const [openInsider, setOpenInsider] = useState<string | null>(null);
  const { t: tr, language } = useI18n();
  const sorted = [...trades].sort(
    (a, b) => (Date.parse(b.tradeDate) || 0) - (Date.parse(a.tradeDate) || 0) || b.value - a.value,
  );

  return (
    <section>
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-secondary">
        {tr('tbl.tradesTitle', { n: trades.length })}
      </h3>
      {/* Mobile: one card per trade. A 7-column table cannot fit 360px — it
          previously overhung the viewport by ~280px and was unreachable, since
          `body{overflow:hidden}` clips instead of scrolling (AUDIT B2/H7). */}
      <div className="flex flex-col gap-2 md:hidden">
        {sorted.map((t, i) => {
          const cls = classifyTransaction(t.transactionType);
          const color = tierColor(cls.tier);
          const excluded = cls.tier === 'excluded';
          const key = normalizeInsiderName(t.insiderName);
          const rowId = `${key}-${i}`;
          const price = t.price ?? (t.shares && t.value ? t.value / t.shares : undefined);
          return (
            <div
              key={i}
              className="rounded-xl p-3"
              style={{ border: '1px solid var(--border-glass)', opacity: excluded ? 0.6 : 1 }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold">{t.insiderName}</div>
                  <div className="truncate text-[13px] text-secondary">{localizeRole(t.role || '—', language)}</div>
                </div>
                <span
                  className="shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold"
                  style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
                >
                  {localizeTransactionLabel(cls.label, language)}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-secondary">{tr('tbl.date')}</dt>
                  <dd className="tabular-nums">{formatDate(t.tradeDate, language) || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-secondary">{tr('tbl.price')}</dt>
                  <dd className="tabular-nums">{formatPrice(price)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-secondary">{tr('tbl.shares')}</dt>
                  <dd className="tabular-nums">{formatNumber(t.shares)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-secondary">{tr('tbl.value')}</dt>
                  <dd className="font-semibold tabular-nums">{formatUSD(t.value)}</dd>
                </div>
              </dl>
              <div className="mt-2">
                <TrackRecordCell
                  record={trackRecords[key]}
                  loading={loading}
                  open={openInsider === rowId}
                  onToggle={() => setOpenInsider(openInsider === rowId ? null : rowId)}
                />
              </div>
              {t.sourceUrl && (
                <a
                  href={t.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="mt-2 inline-flex items-center text-[13px] font-semibold"
                  style={{ minHeight: 44, color: 'var(--accent-blue)' }}
                >
                  {tr('tbl.viewFiling')} <ExternalLinkIcon size={13} />
                </a>
              )}
            </div>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-xl md:block" style={{ border: '1px solid var(--border-glass)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-secondary">
              <th className="px-3 py-2 font-semibold">{tr('tbl.date')}</th>
              <th className="px-3 py-2 font-semibold">{tr('tbl.insider')}</th>
              <th className="px-3 py-2 font-semibold">{tr('tbl.type')}</th>
              <th className="px-3 py-2 font-semibold">{tr('tbl.trackRecord')}</th>
              <th className="px-3 py-2 text-right font-semibold">{tr('tbl.price')}</th>
              <th className="px-3 py-2 text-right font-semibold">{tr('tbl.shares')}</th>
              <th className="px-3 py-2 text-right font-semibold">{tr('tbl.value')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t, i) => {
              const cls = classifyTransaction(t.transactionType);
              const color = tierColor(cls.tier);
              const excluded = cls.tier === 'excluded';
              const key = normalizeInsiderName(t.insiderName);
              const rowId = `${key}-${i}`;
              return (
                <tr
                  key={i}
                  style={{ borderTop: '1px solid var(--border-glass)', opacity: excluded ? 0.55 : 1 }}
                  className={excluded ? 'italic' : ''}
                >
                  <td className="whitespace-nowrap px-3 py-2 text-secondary">{formatDate(t.tradeDate, language) || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium not-italic">{t.insiderName}</div>
                    <div className="text-xs text-secondary">{localizeRole(t.role || '—', language)}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {t.sourceUrl ? (
                      <a
                        href={t.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex hover:opacity-80 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                        title={tr('table.sourceTitle', { source: t.source })}
                      >
                        <span
                          className="inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-bold not-italic cursor-pointer"
                          style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
                        >
                          {localizeTransactionLabel(cls.label, language)} <ExternalLinkIcon size={12} />
                        </span>
                      </a>
                    ) : (
                      <span
                        className="inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-bold not-italic"
                        style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
                        title={cls.tier === 'reduced' ? tr('tbl.reducedWeight') : undefined}
                      >
                        {localizeTransactionLabel(cls.label, language)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <TrackRecordCell
                      record={trackRecords[key]}
                      loading={loading}
                      open={openInsider === rowId}
                      onToggle={() => setOpenInsider(openInsider === rowId ? null : rowId)}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPrice(t.price ?? (t.shares && t.value ? t.value / t.shares : undefined))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(t.shares)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {t.sourceUrl ? (
                      <a
                        href={t.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-white transition-colors"
                        onClick={(e) => e.stopPropagation()}
                        title={tr('table.sourceTitle', { source: t.source })}
                      >
                        {formatUSD(t.value)}
                      </a>
                    ) : (
                      formatUSD(t.value)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
