import { useI18n } from '@/hooks/useI18n';
import { GlassCard } from '@/components/UI/GlassCard';
import { useSourceHealth, type SourceHealthEntry } from '@/hooks/useSourceHealth';
import { useStore } from '@/store/useStore';

const STATUS_META: Record<SourceHealthEntry['status'], { dot: string; label: string; color: string }> = {
  healthy: { dot: '', label: 'OK', color: 'var(--accent-green)' },
  degraded: { dot: '', label: 'Low', color: 'var(--accent-yellow)' },
  flapping: { dot: '', label: 'Flaky', color: 'var(--accent-yellow)' },
  dead: { dot: '', label: 'Dead', color: 'var(--accent-red)' },
  unknown: { dot: '○', label: '—', color: 'var(--text-secondary)' },
};

/** Source diagnostics remain available as ordinary, user-opened information. */
export function SourceHealthBanner() {
  const { t } = useI18n();
  const { dead } = useSourceHealth();
  const setView = useStore((s) => s.setView);
  if (dead.length === 0) return null;
  const names = dead.map((d) => d.label).join(', ');
  return (
    <details className="data-note">
      <summary>{t('srcH.title')}</summary>
      <div className="data-note-body">
        <p>{t(dead.length === 1 ? 'srcH.brokenOne' : 'srcH.brokenMany', { n: dead.length })} {t('srcH.zeroRows', { names })}</p>
        <button className="btn mt-2" onClick={() => setView('settings')}>{t('srcH.viewSources')}</button>
      </div>
    </details>
  );
}

/** Compact per-source health panel — last rows, rolling median, status. */
export function SourceHealthPanel() {
  const { t } = useI18n();
  const { entries } = useSourceHealth();
  const hasData = entries.some((e) => e.status !== 'unknown');

  return (
    <GlassCard className="px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-secondary">{t('srcH.title')}</h3>
        <span className="text-xs text-secondary">{t('srcH.legend')}</span>
      </div>
      {!hasData ? (
        <div className="py-1 text-xs text-secondary">{t('hist.noSessions')}</div>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {entries.map((e) => {
            const meta = STATUS_META[e.status];
            return (
              <div
                key={e.key}
                className="flex items-center gap-2 border-t py-1 text-xs"
                style={{ borderColor: 'var(--border-glass)' }}
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={e.label}>
                  {e.label}
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums">
                  {e.lastRows == null ? '—' : e.lastRows}
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums text-secondary">
                  {e.status === 'unknown' ? '—' : e.median}
                </span>
                {/* Unusable share of the last run's rows. A source can look
                    healthy by row count while the pipeline discards nearly
                    everything it returns — that is what this column shows. */}
                <span
                  className="w-10 shrink-0 text-right tabular-nums"
                  style={{
                    color:
                      e.dropRate == null
                        ? 'var(--text-secondary)'
                        : e.dropRate >= 0.2
                          ? 'var(--accent-red)'
                          : e.dropRate > 0
                            ? 'var(--accent-yellow)'
                            : 'var(--text-secondary)',
                  }}
                  title={
                    e.quality
                      ? `${Math.round((e.dropRate ?? 0) * 100)}% of ${e.quality.rows} row(s) unusable — ` +
                        `ticker ${e.quality.badTicker}, date ${e.quality.badDate}, value ${e.quality.noValue}, ` +
                        `unknown type ${e.quality.unknownType}, no role ${e.quality.noRole}`
                      : t('srcH.noQuality')
                  }
                >
                  {e.dropRate == null ? '—' : `${Math.round(e.dropRate * 100)}%`}
                </span>
                <span
                  className="w-14 shrink-0 text-right font-semibold tabular-nums"
                  style={{ color: meta.color }}
                  title={
                    e.status === 'dead' && e.consecutiveZeroRuns > 0
                      ? `${meta.label} (${e.consecutiveZeroRuns} zero runs)`
                      : e.status === 'flapping'
                        ? `Intermittent: ${e.zeroRunsInWindow} of the last ${e.runsInWindow} runs returned zero rows. ` +
                          `Every one of those drops the signals this source carries.`
                        : meta.label
                  }
                >
                  {meta.label}
                  {e.status === 'dead' && e.consecutiveZeroRuns > 0 ? ` ${e.consecutiveZeroRuns}` : ''}
                  {e.status === 'flapping' ? ` ${e.zeroRunsInWindow}/${e.runsInWindow}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}
