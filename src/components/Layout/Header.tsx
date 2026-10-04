import { useCallback, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { useSignals } from '@/hooks/useSignals';
import { Sheet } from '@/components/UI/Sheet';
import { LanguageToggle } from '@/components/UI/LanguageToggle';
import { VixIndicator } from '@/components/UI/VixIndicator';
import { RefreshIcon, BellIcon } from '@/components/UI/icons';
import { timeAgo } from '@/lib/format';
import { isWeb } from '@/lib/ipc';
import { useI18n } from '@/hooks/useI18n';
import type { TKey } from '@/lib/i18n';

const VIEW_META: Record<string, { title: TKey; subtitle: TKey }> = {
  analysis: { title: 'view.analysis.title', subtitle: 'view.analysis.subtitle' },
  dashboard: { title: 'view.dashboard.title', subtitle: 'view.dashboard.subtitle' },
  portfolio: { title: 'view.portfolio.title', subtitle: 'view.portfolio.subtitle' },
  news: { title: 'view.news.title', subtitle: 'view.news.subtitle' },
  watchlist: { title: 'view.watchlist.title', subtitle: 'view.watchlist.subtitle' },
  history: { title: 'view.history.title', subtitle: 'view.history.subtitle' },
  settings: { title: 'view.settings.title', subtitle: 'view.settings.subtitle' },
};

export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const initialized = useStore((s) => s.initialized);
  const signalError = useStore((s) => s.scrapeStatus.error?.includes('signals.json'));
  const view = useStore((s) => s.view);
  const signals = useStore((s) => s.signals);
  const openSignal = useStore((s) => s.openSignal);
  const { scrapeStatus, lastScrapeAt, refresh } = useSignals();
  const { t, language } = useI18n();
  const meta = VIEW_META[view] ?? VIEW_META.dashboard;
  const running = scrapeStatus.running;

  const [bellOpen, setBellOpen] = useState(false);
  const closeNotifications = useCallback(() => setBellOpen(false), []);

  const highSignals = useMemo(
    () =>
      signals
        .filter((s) => s.convictionLevel === 'HIGH')
        .slice()
        .sort((a, b) => b.score - a.score),
    [signals],
  );


  return (
    <header
      className="flex items-center gap-2 px-4 py-3 select-none lg:gap-4 lg:px-8 lg:py-5"
      // Drag regions only mean something in an Electron frame; in the browser they
      // are inert and can swallow pointer interaction.
      style={isWeb ? undefined : ({ WebkitAppRegion: 'drag' } as any)}
    >
      {/* Hamburger — drawer only exists in the md–lg band; below md the bottom tab
          bar navigates directly, so the trigger would be dead weight. */}
      <button
        type="button"
        className="icon-btn hidden shrink-0 md:inline-flex lg:hidden"
        aria-label={t('nav.openMenu')}
        onClick={() => onMenuClick?.()}
        style={isWeb ? undefined : ({ WebkitAppRegion: 'no-drag' } as any)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-extrabold tracking-tight lg:text-2xl">{t(meta.title)}</h1>
        {/* The subtitle only ever truncated on a phone; it earns its line from md up. */}
        <p className="hidden truncate text-xs text-secondary md:block lg:text-sm">{t(meta.subtitle)}</p>
      </div>

      {/* Live scrape phase */}
      {!isWeb && running && (
        <div className="hidden items-center gap-2 text-sm text-secondary md:flex">
          <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: 'var(--accent-blue)' }} />
          <span className="max-w-[16rem] truncate">{scrapeStatus.phase}</span>
          {scrapeStatus.totalSources > 0 && (
            <span className="tabular-nums">
              ({scrapeStatus.completedSources.length}/{scrapeStatus.totalSources})
            </span>
          )}
        </div>
      )}

      {/* Hosted freshness is shown by the per-stage update panel below. */}
      {!isWeb && <div className="shrink-0 text-right">
        <div className="hidden text-xs uppercase tracking-wide text-secondary sm:block">{t('header.lastScrape')}</div>
        <div className="text-xs font-semibold tabular-nums sm:text-sm">{timeAgo(lastScrapeAt, language)}</div>
      </div>}

      {/* Interactive controls */}
      <div className="flex items-center gap-2 lg:gap-4" style={isWeb ? undefined : ({ WebkitAppRegion: 'no-drag' } as any)}>
        {/* Notification bell — HIGH conviction list */}
        <div className="relative">
          <button
            type="button"
            className="icon-btn relative"
            title={t('header.highSignalsTitle', { count: highSignals.length })}
            aria-label={t('header.notifications')}
            aria-haspopup="dialog"
            aria-expanded={bellOpen}
            onClick={() => setBellOpen((o) => !o)}
          >
            <BellIcon size={18} />
            {highSignals.length > 0 && (
              <span
                className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[11px] font-bold text-white"
                style={{ background: 'var(--accent-red)' }}
              >
                {highSignals.length}
              </span>
            )}
          </button>
          <Sheet open={bellOpen} onClose={closeNotifications} title={t('header.notifications')} maxHeight="min(80svh, 620px)">
            <p className="mb-3 text-xs text-secondary">{t('header.highConviction')}</p>
            {!initialized ? <div className="empty-state">{t('common.loading')}</div> : signalError && highSignals.length === 0 ? <div className="empty-state">{t('ui.loadError')}</div> : highSignals.length === 0 ? <div className="empty-state"><BellIcon size={26} aria-hidden="true" /><p>{t('header.noHighConviction')}</p></div> :
              <ul className="notification-list">{highSignals.map((signal) => <li key={signal.ticker}>
                <button type="button" onClick={() => { closeNotifications(); openSignal(signal.ticker); }}>
                  <span><strong>{signal.ticker}</strong><span className="text-xs text-secondary">{signal.companyName}</span></span>
                  <span className="neutral-badge">{signal.score.toFixed(0)} / 100</span>
                </button>
              </li>)}</ul>}
          </Sheet>
        </div>

        <VixIndicator />

        <LanguageToggle />

        {/* Manual refresh — desktop/Electron only. On the web the data comes from
            the scheduled GitHub Actions scrape, so an in-app refresh does nothing. */}
        {!isWeb && (
          <button className="btn btn-primary shrink-0" onClick={() => refresh()} disabled={running}>
            <RefreshIcon size={16} className={running ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">{running ? t('header.scraping') : t('header.refresh')}</span>
          </button>
        )}
      </div>
    </header>
  );
}
