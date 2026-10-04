import { useEffect, useState } from 'react';
import { useStore, type View } from '@/store/useStore';
import { GridIcon, StarIcon, HistoryIcon, SettingsIcon, NewsIcon, BriefcaseIcon } from '@/components/UI/icons';

import { api, isWeb } from '@/lib/ipc';
import { useI18n } from '@/hooks/useI18n';
import type { TKey } from '@/lib/i18n';

interface NavItem {
  key: View;
  label: TKey;
  icon: (p: { size?: number }) => JSX.Element;
  /** Hidden on the hosted build — see NAV below. */
  desktopOnly?: boolean;
}

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'nav.alerts', icon: GridIcon },
  { key: 'analysis', label: 'nav.analysis', icon: NewsIcon },
  // The testing portfolio sits directly under the alerts it is built from, and
  // exists in BOTH builds — the hosted one reads the published curve.
  { key: 'portfolio', label: 'nav.portfolio', icon: BriefcaseIcon },
  // News is scraped from X by the desktop app into its local database; the
  // hosted build has neither that scraper nor the rows, so the tab was always
  // an empty view there.
  { key: 'news', label: 'nav.news', icon: NewsIcon, desktopOnly: true },
  { key: 'watchlist', label: 'nav.watchlist', icon: StarIcon },
  { key: 'history', label: 'nav.history', icon: HistoryIcon },
  { key: 'settings', label: 'nav.settings', icon: SettingsIcon },
];

export const VISIBLE_NAV = NAV.filter((n) => !(isWeb && n.desktopOnly));

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const watchlistCount = useStore((s) => s.watchlist.length);
  const scheduleEnabled = useStore((s) => s.settings.scheduleEnabled);
  const [version, setVersion] = useState<string>('');
  const { t } = useI18n();

  useEffect(() => {
    api.app.getVersion().then(setVersion).catch(() => undefined);
  }, []);

  const go = (key: View) => {
    setView(key);
    onClose?.(); // close the drawer after navigating on mobile
  };

  return (
    <aside
      className={`glass fixed inset-y-3 left-3 z-50 hidden w-60 flex-col rounded-2xl p-4 transition-transform duration-300 md:flex lg:static lg:inset-auto lg:m-3 lg:mr-0 lg:shrink-0 lg:translate-x-0 lg:transition-none ${
        open ? 'translate-x-0' : '-translate-x-[120%]'
      }`}
    >
      {/* Logo + mobile close */}
      <div className="mb-6 flex items-center justify-between px-2 pt-1">
        <div className="leading-tight">
          <div className="text-sm font-extrabold">Insider &amp; Whale</div>
          <div className="text-xs text-secondary">Terminal</div>
        </div>
        <button
          type="button"
          className="icon-btn lg:hidden"
          aria-label={t('nav.closeMenu')}
          onClick={() => onClose?.()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1">
        {VISIBLE_NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.key;
          return (
            <button
              key={item.key}
              aria-current={active ? 'page' : undefined}
              className={`sidebar-item ${active ? 'sidebar-item-active' : ''}`}
              onClick={() => go(item.key)}
            >
              <Icon size={18} />
              <span className="flex-1 text-left">{t(item.label)}</span>
              {item.key === 'watchlist' && watchlistCount > 0 && (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                  style={{
                    color: 'var(--accent-blue)',
                    background: 'color-mix(in srgb, var(--accent-blue) 16%, transparent)',
                  }}
                >
                  {watchlistCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto px-2 flex items-center justify-between">
        {!isWeb && <div className="flex items-center gap-2 text-xs text-secondary">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: scheduleEnabled ? 'var(--accent-green)' : 'var(--text-secondary)' }}
          />
          {scheduleEnabled ? t('nav.autoRefreshOn') : t('nav.autoRefreshOff')}
        </div>}
        {version && <span className="text-[10px] text-secondary/50 font-medium select-none">v{version}</span>}
      </div>
    </aside>
  );
}
