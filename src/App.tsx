import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import { api, isElectron, isWeb } from '@/lib/ipc';
import { Layout } from '@/components/Layout/Layout';
import { Dashboard } from '@/components/Dashboard/Dashboard';
import { AnalysisView } from '@/components/Analysis/AnalysisView';
import { WatchlistView } from '@/components/Watchlist/WatchlistView';
import { PortfolioView } from '@/components/Portfolio/PortfolioView';
import { HistoryView } from '@/components/History/HistoryView';
import { SettingsPanel } from '@/components/Settings/SettingsPanel';
import { NewsView } from '@/components/News/NewsView';
import { SignalModal } from '@/components/Detail/SignalModal';
import { WelcomeModal } from '@/components/Welcome/WelcomeModal';
import { useI18n } from '@/hooks/useI18n';

export default function App() {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const { t } = useI18n();
  const [showWelcome, setShowWelcome] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  // Skip the 5 MB intro video on the web build (heavy + 10s delay on mobile data).
  const [showIntro, setShowIntro] = useState(!isWeb);
  const [isFading, setIsFading] = useState(false);

  const handleIntroEnd = () => {
    setIsFading((fading) => {
      if (fading) return fading;
      setTimeout(() => {
        setShowIntro(false);
      }, 500);
      return true;
    });
  };

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    // Hard fallback: if the video is completely blocked/throttled or runs in the background,
    // force fade out after 11 seconds (video duration is 10 seconds).
    const fallbackTimer = setTimeout(() => {
      handleIntroEnd();
    }, 11000);
    return () => clearTimeout(fallbackTimer);
  }, []);

  useEffect(() => {
    const checkVersion = async () => {
      if (isElectron && window.api?.app?.getVersion) {
        try {
          const ver = await window.api.app.getVersion();
          setAppVersion(ver);
          const lastSeen = localStorage.getItem('last_seen_version');
          if (lastSeen !== ver) {
            setShowWelcome(true);
          }
        } catch (err) {
          console.error('Failed to get app version:', err);
        }
      } else {
        // Web: "what's new" only makes sense for someone who has ALREADY seen an
        // earlier build. A first-time visitor never "updated", so ambushing them
        // with a changelog is wrong — and the version must come from the published
        // meta.json, not a hardcoded one (it read "new in 1.0.21" at v1.1.16).
        const ver = await api.app.getVersion().catch(() => '');
        if (ver) setAppVersion(ver);
        const lastSeen = localStorage.getItem('last_seen_version');
        if (!lastSeen) {
          // Remember the version silently; release notes are available inline.
          localStorage.setItem('last_seen_version', ver || 'web');
        } else if (ver && lastSeen !== ver) {
          localStorage.setItem('last_seen_version', ver);
        }
      }
    };
    void checkVersion();
  }, []);

  const handleCloseWelcome = () => {
    localStorage.setItem('last_seen_version', appVersion || 'web');
    setShowWelcome(false);
  };

  return (
    <>
      {showIntro && (
        <div
          className={`fixed inset-0 z-[9999] bg-black flex items-center justify-center transition-opacity duration-500 ${
            isFading ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <video
            src="./intro.mp4"
            autoPlay
            muted
            playsInline
            onEnded={handleIntroEnd}
            onError={() => setShowIntro(false)}
            className="max-w-[50%] max-h-[50%] object-contain"
          />
        </div>
      )}

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
        {view === 'watchlist' && <WatchlistView />}
        {view === 'history' && <HistoryView />}
        {/* News lives only in the desktop app — the hosted build has no X scraper. */}
        {view === 'news' && !isWeb && <NewsView />}
        {view === 'settings' && <SettingsPanel />}

        <SignalModal />

        {showWelcome && (
          <WelcomeModal
            version={appVersion || '1.0.15'}
            lastSeenVersion={localStorage.getItem('last_seen_version')}
            onClose={handleCloseWelcome}
          />
        )}
      </Layout>
    </>
  );
}
