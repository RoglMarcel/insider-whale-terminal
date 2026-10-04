import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { BottomTabBar } from './BottomTabBar';
import { UpdateNotification } from '@/components/UI/UpdateNotification';
import { UpdateHealth } from '@/components/UI/UpdateHealth';
import { useStore } from '@/store/useStore';
import { useI18n } from '@/hooks/useI18n';
import { isWeb } from '@/lib/ipc';

export function Layout({ children }: { children: ReactNode }) {
  // Drawer state applies to the md–lg band only; below md the bottom tab bar
  // navigates directly, above lg the sidebar is a static column.
  const [navOpen, setNavOpen] = useState(false);
  const dataError = useStore((s) => s.scrapeStatus.error);
  const { t } = useI18n();

  return (
    <div className="app-shell relative z-10 flex h-full w-full overflow-hidden">
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setNavOpen(true)} />
        <main
          className="min-h-0 flex-1 overflow-y-auto"
          style={{
            // One scroll container. `contain` stops the page behind a sheet from
            // rubber-banding, and the bottom padding keeps the last card clear of
            // the tab bar instead of hiding behind it.
            overscrollBehavior: 'contain',
            paddingLeft: 'max(var(--page-x), var(--sa-left))',
            paddingRight: 'max(var(--page-x), var(--sa-right))',
            paddingBottom: 'calc(var(--tabbar-h) + var(--sa-bottom) + var(--page-bottom))',
            scrollPaddingBottom: 'calc(var(--tabbar-h) + var(--sa-bottom))',
          }}
        >
          {children}
          <footer className="data-notes">
            <UpdateHealth />
            {isWeb && dataError && <p className="text-xs text-secondary">{t('ui.loadError')}</p>}
            {!isWeb && <UpdateNotification />}
          </footer>
        </main>
      </div>
      <BottomTabBar />
    </div>
  );
}
