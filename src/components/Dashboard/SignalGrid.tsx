import { isWeb } from '@/lib/ipc';
import type { Signal } from '@/types';
import { SignalCard } from './SignalCard';
import { GlassCard } from '@/components/UI/GlassCard';
import { useStore } from '@/store/useStore';
import { useSignals } from '@/hooks/useSignals';
import { SearchIcon, RefreshIcon } from '@/components/UI/icons';
import { useI18n } from '@/hooks/useI18n';

export function SignalGrid({ signals, hasSearchQuery }: { signals: Signal[]; hasSearchQuery?: boolean }) {
  const { scrapeStatus, refresh } = useSignals();
  const initialized = useStore((s) => s.initialized);
  const totalSignals = useStore((s) => s.signals.length);
  const { t } = useI18n();

  if (!initialized) return <GlassCard className="empty-state text-secondary">{t('common.loading')}</GlassCard>;
  if (isWeb && totalSignals === 0 && scrapeStatus.error?.includes('signals.json')) {
    return <GlassCard className="empty-state">{t('ui.loadError')}</GlassCard>;
  }
  if (signals.length === 0) {
    return (
      <GlassCard className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-2xl text-secondary"
          style={{ background: 'var(--bg-glass)' }}
        >
          <SearchIcon size={28} />
        </div>
        <div>
          <div className="text-lg font-bold">
            {totalSignals === 0
              ? t('grid.noSignalsYet')
              : hasSearchQuery
              ? t('grid.noSearchMatch')
              : t('grid.noFilterMatch')}
          </div>
          <p className="mx-auto mt-1 max-w-md text-sm text-secondary">
            {totalSignals === 0
              ? t(isWeb ? 'ui.noAlertsHint' : 'grid.noSignalsYetHint')
              : hasSearchQuery
              ? t('grid.noSearchMatchHint')
              : t('grid.noFilterMatchHint')}
          </p>
        </div>
        {totalSignals === 0 && !isWeb && (
          <button className="btn btn-primary" onClick={() => refresh()} disabled={scrapeStatus.running}>
            <RefreshIcon size={16} className={scrapeStatus.running ? 'animate-spin' : ''} />
            {scrapeStatus.running ? t('header.scraping') : t('grid.runFirstScrape')}
          </button>
        )}
      </GlassCard>
    );
  }

  return (
    <div className="signal-grid grid auto-rows-fr grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
      {signals.map((signal) => (
        <SignalCard key={signal.ticker} signal={signal} />
      ))}
    </div>
  );
}
