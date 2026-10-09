import { useStore, type View } from '@/store/useStore';
import { GridIcon, StarIcon, HistoryIcon, SettingsIcon, NewsIcon, BriefcaseIcon } from '@/components/UI/icons';
import { isWeb } from '@/lib/ipc';
import { useI18n } from '@/hooks/useI18n';
import type { TKey } from '@/lib/i18n';

interface Tab {
  key: View;
  label: TKey;
  icon: (p: { size?: number }) => JSX.Element;
  desktopOnly?: boolean;
}

/** Same destinations as the sidebar, in the same order. */
const TABS: Tab[] = [
  { key: 'dashboard', label: 'nav.alerts', icon: GridIcon },
  { key: 'analysis', label: 'nav.analysis', icon: NewsIcon },
  // Six tabs on the desktop build leaves ~60px each at 360px, so this one uses
  // the SHORT label. Shortening the word is the right trade — shrinking the
  // touch target is not.
  { key: 'portfolio', label: 'nav.portfolioShort', icon: BriefcaseIcon },
  { key: 'news', label: 'nav.newsShort', icon: NewsIcon, desktopOnly: true },
  { key: 'watchlist', label: 'nav.watchlistShort', icon: StarIcon },
  { key: 'history', label: 'nav.history', icon: HistoryIcon },
  // 'Einstellungen' is 13 characters; with the portfolio tab added it no longer
  // fits ~60px and overflowed the bar at 360px. Shortening the WORD is the right
  // trade — shrinking the touch target is not.
  { key: 'settings', label: 'nav.settingsShort', icon: SettingsIcon },
  { key: 'backtest', label: 'nav.backtest', icon: HistoryIcon },
];

const VISIBLE_TABS = TABS.filter((tb) => !(isWeb && tb.desktopOnly));

/**
 * Bottom tab bar — the mobile navigation (DESIGN.md §8).
 *
 * Replaces the hamburger drawer below `md`, which cost two taps per view and put
 * the trigger in the hardest corner to reach with a thumb. Hidden from `md` up,
 * where the drawer (and above `lg`, the static sidebar) takes over, so the
 * desktop layout is untouched.
 *
 * Each button is a full-height 44px+ target and carries its own safe-area
 * padding so it clears the iPhone home indicator.
 */
export function BottomTabBar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const watchlistCount = useStore((s) => s.watchlist.length);
  const { t } = useI18n();

  return (
    <nav
      aria-label={t('nav.main')}
      className="fixed inset-x-0 bottom-0 z-40 flex overflow-x-auto md:hidden"
      style={{
        paddingBottom: 'var(--sa-bottom)',
        background: 'var(--bg-glass)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderTop: '1px solid var(--border-glass)',
      }}
    >
      {VISIBLE_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = view === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => setView(tab.key)}
            className="relative flex min-w-[60px] flex-1 shrink-0 flex-col items-center justify-center gap-0.5 transition-colors"
            style={{
              height: 'var(--tabbar-h)',
              color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
            }}
          >
            <span className="relative flex items-center justify-center">
              <Icon size={22} />
              {tab.key === 'watchlist' && watchlistCount > 0 && (
                <span
                  className="absolute -right-2.5 -top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[11px] font-bold tabular-nums text-white"
                  style={{ background: 'var(--accent-blue)' }}
                >
                  {watchlistCount > 99 ? '99+' : watchlistCount}
                </span>
              )}
            </span>
            <span className="text-xs" style={{ fontWeight: active ? 700 : 500 }}>
              {t(tab.label)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
