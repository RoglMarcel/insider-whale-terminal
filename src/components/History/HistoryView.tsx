import { useI18n } from '@/hooks/useI18n';
import { useStore } from '@/store/useStore';
import { SCRAPER_SOURCES, SIDE_PIPELINE_SOURCES, sourceLabel } from '@/types';
import { GlassCard } from '@/components/UI/GlassCard';
import { HistoryIcon } from '@/components/UI/icons';
import { formatDateTime } from '@/lib/format';
import { PerformancePanel } from './PerformancePanel';
import { SourceHealthPanel } from '@/components/UI/SourceHealth';
import { isWeb } from '@/lib/ipc';

export function HistoryView() {
  const { t, language } = useI18n();
  const logs = useStore((s) => s.scrapeLogs);
  const loadError = useStore((s) => s.scrapeStatus.error?.includes('meta.json'));
  const initialized = useStore((s) => s.initialized);
  return <div className="history-view workspace-view animate-fade-in">
    {!isWeb && <><PerformancePanel /><SourceHealthPanel /></>}
    <GlassCard className="p-5">
      <h3 className="section-title">{t('ui.historyTitle')}</h3>
      <p className="mb-4 text-xs text-secondary">{t('ui.historyHint')}</p>
      {!initialized ? <div className="empty-state">{t('common.loading')}</div> : logs.length === 0 ?
        <div className="empty-state"><HistoryIcon size={24} /><p>{t(loadError ? 'ui.loadError' : 'ui.historyEmpty')}</p></div> :
        <div className="history-list">
          {logs.map((log, index) => {
            const sources = log.sourcesScraped.map((key) => {
              const meta = SCRAPER_SOURCES.find((s) => s.key.toLowerCase() === key.toLowerCase() || s.label.toLowerCase() === key.toLowerCase());
              const side = SIDE_PIPELINE_SOURCES.find((s) => s.key === key.toLowerCase());
              const count = log.sourceBreakdown?.[meta?.key ?? side?.key ?? key.toLowerCase()] ?? log.sourceBreakdown?.[key];
              return { key, label: meta?.label ?? side?.label ?? sourceLabel(key), count };
            }).filter((s) => s.count == null || s.count >= 0);
            return <details className="history-entry" key={`${log.id ?? index}-${log.startedAt}`}>
              <summary>
                <HistoryIcon size={18} aria-hidden="true" />
                <span className="history-entry-date">{formatDateTime(log.startedAt, language)}<span className="text-xs text-secondary">{t('ui.historySources', { n: log.sourcesScraped.length })}</span></span>
                <span className="history-entry-count">{log.signalsFound}<span className="text-xs text-secondary">{t('ui.alerts')}</span></span>
                <span className="neutral-badge">{t(log.status === 'success' ? 'ui.available' : log.status === 'partial' ? 'ui.partial' : 'ui.unavailable')}</span>
              </summary>
              <div className="history-entry-content">
                {sources.length ? <dl className="history-source-grid">{sources.map((s) => <div key={s.key}><dt>{s.label}</dt><dd>{s.count == null ? t('ui.countUnavailable') : t('ui.sourceCount', { n: s.count })}</dd></div>)}</dl> : <p>{t('ui.countUnavailable')}</p>}
              </div>
            </details>;
          })}
        </div>}
    </GlassCard>
  </div>;
}
