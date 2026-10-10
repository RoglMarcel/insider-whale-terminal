import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { isElectron, isWeb } from '@/lib/ipc';
import { Layout } from '@/components/Layout/Layout';
import { Dashboard } from '@/components/Dashboard/Dashboard';
import { AnalysisView } from '@/components/Analysis/AnalysisView';
import { WatchlistView } from '@/components/Watchlist/WatchlistView';
import { PortfolioView } from '@/components/Portfolio/PortfolioView';
import { BacktestView } from '@/components/Backtest/BacktestView';
import { HistoryView } from '@/components/History/HistoryView';
import { SettingsPanel } from '@/components/Settings/SettingsPanel';
import { NewsView } from '@/components/News/NewsView';
import { SignalModal } from '@/components/Detail/SignalModal';
import { useI18n } from '@/hooks/useI18n';

export default function App() {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const { t } = useI18n();
  useEffect(() => { void init(); }, [init]);

  return (
    <>
      <Layout>
        {!isElectron && !isWeb && (
          <div
            className="mb-4 rounded-xl px-4 py-2 text-sm"
            style={{
              background: 'color-mix(in srgb, var(--accent-yellow) 16%, transparent)',
              color: 'var(--text-primary)',
              border: '1px solid color-mix(in srgb, var(--accent-yellow) 30%, transparent)',
            }}
          >
            {t('app.previewMode')}
          </div>
        )}

        {view === 'dashboard' && <Dashboard />}
        {view === 'analysis' && <AnalysisView />}
        {view === 'portfolio' && <PortfolioView />}
        {view === 'backtest' && <BacktestView />}
        {view === 'watchlist' && <WatchlistView />}
        {view === 'history' && <HistoryView />}
        {/* News lives only in the desktop app — the hosted build has no X scraper. */}
        {view === 'news' && !isWeb && <NewsView />}
        {view === 'settings' && <SettingsPanel />}

        <SignalModal />

      </Layout>
    </>
  );
}
