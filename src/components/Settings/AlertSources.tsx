import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { useI18n } from '@/hooks/useI18n';
import { GlassCard } from '@/components/UI/GlassCard';
import { summarizeAlertSources } from '@/lib/alert-sources';

export function AlertSources() {
  const signals = useStore((s) => s.signals);
  const loadError = useStore((s) => s.scrapeStatus.error?.includes('signals.json'));
  const initialized = useStore((s) => s.initialized);
  const { t } = useI18n();
  const sources = useMemo(() => summarizeAlertSources(signals), [signals]);
  const unattributedCongress = signals.some((s) => s.politicianTrades?.length);
  return <GlassCard className="p-5 alert-sources">
    <h3 className="section-title">{t('ui.sourcesTitle')}</h3>
    <p className="mb-3 text-xs text-secondary">{t('ui.sourcesHint')}</p>
    {!initialized ? <p className="text-sm text-secondary">{t('common.loading')}</p> : sources.length === 0 ?
      <p className="text-sm text-secondary">{t(loadError ? 'ui.loadError' : 'ui.noSources')}</p> :
      <ul className="source-list">
        {sources.map((source) => <li key={source.key}>
          <div><span className="font-semibold">{source.name}</span><p className="text-xs text-secondary">{t(source.kind === 'insider' ? 'ui.insiderSource' : 'ui.optionsSource')}</p></div>
          <span className="neutral-badge">{t('ui.sourceCount', { n: source.alerts })}</span>
        </li>)}
      </ul>}
    {unattributedCongress && <p className="mt-3 text-xs text-secondary">{t('ui.congressSource')}</p>}
  </GlassCard>;
}
