import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { GlassCard } from '@/components/UI/GlassCard';
import type { PerformanceReport } from '@/types';
import { api } from '@/lib/ipc';
import { formatDate, formatDateTime } from '@/lib/format';

/**
 * Signal calibration dashboard — realized 10/20-day alpha vs SPY of stored
 * signals, by conviction tier and score bucket (F31-deduplicated, adjusted
 * closes only). Makes the conviction score auditable from inside the app.
 */
const pct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const alphaColor = (v: number): string => (v >= 0 ? 'var(--accent-green)' : 'var(--accent-red)');

export function PerformancePanel() {
  const { t, language } = useI18n();
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.performance
      .getLatest()
      .then((r) => active && setReport(r))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const recompute = async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await api.performance.recompute());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('perf.recomputeFailed'));
    } finally {
      setRunning(false);
    }
  };

  const maxAbsAlpha = Math.max(1, ...(report?.buckets.map((b) => Math.abs(b.avgAlpha10)) ?? []));

  return (
    <GlassCard className="p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold uppercase tracking-wide text-secondary">{t('perf.title')}</h3>
        <button className="btn" onClick={() => void recompute()} disabled={running}>
          {running ? t('perf.computing') : report ? t('perf.recompute') : t('perf.compute')}
        </button>
      </div>

      {error && <div className="py-2 text-sm" style={{ color: 'var(--accent-red)' }}>{error}</div>}

      {!report ? (
        <div className="py-4 text-sm text-secondary">
          No calibration run yet — press Compute to replay stored signals against realized returns. Signals need
          ~4 weeks to ripen before they count.
        </div>
      ) : (
        <>
          <div className="mb-3 text-xs text-secondary">
            {report.nObservations} deduplicated observations
            {report.fromDate ? ` · ${formatDate(report.fromDate, language)} → ${formatDate(report.toDate, language)}` : ''} · computed{' '}
            {formatDateTime(report.ranAt, language)}
            {report.ic10 != null && (
              <>
                {' '}
                · IC (score ↔ 10d alpha):{' '}
                <span className="font-semibold" style={{ color: report.ic10 >= 0.05 ? 'var(--accent-green)' : 'var(--text-primary)' }}>
                  {report.ic10.toFixed(3)}
                </span>
              </>
            )}
          </div>

          {report.note && (
            <div
              className="mb-3 rounded-xl px-3 py-2 text-xs"
              style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)', color: 'var(--text-secondary)' }}
            >
              {report.note}
            </div>
          )}

          {report.tiers.length > 0 && (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-secondary">
                    <th className="py-1.5 pr-3 font-semibold">{t('perf.tier')}</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">n</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">{t('perf.winRate10d')}</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Avg α 10d</th>
                    <th className="py-1.5 text-right font-semibold">Avg α 20d</th>
                  </tr>
                </thead>
                <tbody>
                  {report.tiers.map((t) => (
                    <tr key={t.tier} style={{ borderTop: '1px solid var(--border-glass)' }}>
                      <td className="py-2 pr-3 font-semibold">{t.tier}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{t.n}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{Math.round(t.winRate10 * 100)}%</td>
                      <td className="py-2 pr-3 text-right font-semibold tabular-nums" style={{ color: alphaColor(t.avgAlpha10) }}>
                        {pct(t.avgAlpha10)}
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums" style={{ color: alphaColor(t.avgAlpha20) }}>
                        {pct(t.avgAlpha20)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.buckets.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs uppercase tracking-wide text-secondary">Avg 10d alpha by score bucket</div>
              {report.buckets.map((b) => (
                <div key={b.label} className="grid grid-cols-[4.5rem_1fr_6.5rem] items-center gap-3">
                  <span className="text-xs tabular-nums text-secondary">{b.label}</span>
                  <div className="h-2.5 overflow-hidden rounded-full" style={{ background: 'var(--border-glass)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(Math.abs(b.avgAlpha10) / maxAbsAlpha, 1) * 100}%`,
                        background: alphaColor(b.avgAlpha10),
                      }}
                    />
                  </div>
                  <span className="text-right text-xs font-semibold tabular-nums" style={{ color: alphaColor(b.avgAlpha10) }}>
                    {pct(b.avgAlpha10)} (n={b.n})
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </GlassCard>
  );
}
