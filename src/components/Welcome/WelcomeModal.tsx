import { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { createPortal } from 'react-dom';

interface SlideData {
  version: string;
  title: string;
  subtitle: string;
  bullets: Array<{ title: string; desc: string }>;
}

const slides: SlideData[] = [
  {
    version: "1.0.13",
    title: "Version 1.0.13 Update",
    subtitle: "Track record valuation details and layout cleanup",
    bullets: [
      {
        title: "Transaction Amounts in History",
        desc: "The historical trades table within insider track records now displays transaction quantities and total dollar values."
      },
      {
        title: "Application Menu Bar Cleanup",
        desc: "Removed the standard top window menu bar (File, Edit, View, etc.) to optimize active viewport workspace."
      }
    ]
  },
  {
    version: "1.0.14",
    title: "Version 1.0.14 Update",
    subtitle: "Onboarding and update workflow integration",
    bullets: [
      {
        title: "Onboarding Documentation",
        desc: "Introduced the interactive release notes onboarding modal to outline key engine updates directly in the app."
      }
    ]
  },
  {
    version: "1.0.15",
    title: "Version 1.0.15 Update",
    subtitle: "Earnings scheduler and scraper resilience enhancements",
    bullets: [
      {
        title: "Scraper Timeout Resolution",
        desc: "Resolved the global scraper timeout bug by introducing progressive result aggregation, ensuring earnings dates are successfully saved."
      },
      {
        title: "Decoupled Earnings Date Scraping",
        desc: "Earnings calendar schedules now execute independently of the Finviz insider trading scraper toggle settings."
      }
    ]
  },
  {
    version: "1.0.16",
    title: "Version 1.0.16 Update",
    subtitle: "Scraper login session persistence and valuation fixes",
    bullets: [
      {
        title: "Session Login Persistence",
        desc: "Fixed cookie expiration date truncation and domain mismatches to ensure all scrapers correctly retain active login sessions."
      },
      {
        title: "IndexedDB Token Synchronization",
        desc: "Implemented a local IndexedDB storage tunnel to restore Firebase Auth and other state managers across sessions."
      },
      {
        title: "Intrinsic Value Scraper Corrections",
        desc: "Enhanced fair-value text extraction to filter out promo percentages (e.g. $20.00 bug) and detect subscription view limits."
      }
    ]
  },
  {
    version: "1.0.18",
    title: "Version 1.0.18 Update",
    subtitle: "System tray background service, auto-start & live news",
    bullets: [
      {
        title: "Tray Background Service & Second-Launch Fix",
        desc: "Terminal now hides to the tray on close. Attempting to start the app a second time now successfully restores and focuses the hidden window."
      },
      {
        title: "Start with Windows",
        desc: "Added an option in Settings to launch the terminal automatically on system boot in a minimized background state."
      },
      {
        title: "Live News Feed Tab",
        desc: "Scrapes the @WhaleInsider news timeline every 5 minutes using your session credentials, featuring clickable tickers and OS notifications."
      }
    ]
  },
  {
    version: "1.0.19",
    title: "Version 1.0.19 Update",
    subtitle: "Direct transaction & SEC filing links",
    bullets: [
      {
        title: "Direct Filing Links",
        desc: "Clicking the 'Open Market Buy' (or other transaction badges) now redirects you directly to the specific SEC Form 4 filing page or transaction detail page."
      }
    ]
  },
  {
    version: "1.0.20",
    title: "Version 1.0.20 Update",
    subtitle: "Auto-updater race condition & background tray fixes",
    bullets: [
      {
        title: "Update Available Caching",
        desc: "Resolved the race condition where the update available/downloaded popup was missed on startup by caching status in the main process and querying it on mount."
      },
      {
        title: "Native OS Update Notifications",
        desc: "Added native Windows OS notification popups when a new software update is fully downloaded, allowing you to restart and update directly from the notification."
      }
    ]
  },
  {
    version: "1.0.21",
    title: "Version 1.0.21 Update",
    subtitle: "Auto-updater quit resolution & installer locks fix",
    bullets: [
      {
        title: "Graceful Updater Exits",
        desc: "Modified the application exit sequence so that when the auto-updater triggers a reload, the window close event is bypassed and terminates cleanly."
      },
      {
        title: "Process Locking Solved",
        desc: "Configured the Windows setup wizard to locate and close any background or system tray app instances automatically, allowing updates to install smoothly."
      }
    ]
  },
  {
    version: '1.7.0',
    title: 'Version 1.7.0 · Backtest',
    subtitle: 'Depotentscheidungen nachvollziehbar auswerten',
    bullets: [
      { title: 'Unveränderliche Kaufdaten', desc: 'Originale Alert-Daten, Bewertungsinputs und Ausführungsdaten werden dauerhaft archiviert. Historische Lücken sind sichtbar.' },
      { title: 'Analysen und Export', desc: 'Geschlossene Positionen erhalten versionierte Auswertungen mit belegten Beobachtungen, Grenzen und Optimierungshypothesen. Alle Daten lassen sich als JSON exportieren.' },
    ],
  },
  {
    version: '1.7.1',
    title: 'Version 1.7.1 · Desktop und Web',
    subtitle: 'Gemeinsamer Datenstand mit automatischem Abgleich',
    bullets: [
      { title: 'Abgleich in beide Richtungen', desc: 'Lokale Scrapes werden veröffentlicht. Der Desktop übernimmt Verlauf, Depot und Backtests automatisch von der Website.' },
      { title: 'Daten bleiben erhalten', desc: 'Wiederholte Übertragungen erzeugen keine zusätzlichen Einträge. Frühere lokale Depotstände werden archiviert; fehlgeschlagene Übertragungen werden erneut versucht.' },
    ],
  },
];

function parseVersionNum(v: string): number {
  if (!v) return 0;
  const parts = v.split('.');
  const num = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(num) ? num : 0;
}

export function WelcomeModal({
  version,
  lastSeenVersion,
  onClose,
}: {
  version: string;
  lastSeenVersion: string | null;
  onClose: () => void;
}) {
  // If lastSeenVersion is null (fresh install), we show all slides.
  // Otherwise, we only show slides newer than the last seen version.
  const lastSeenNum = lastSeenVersion ? parseVersionNum(lastSeenVersion) : 0;
  const applicableSlides = lastSeenVersion 
    ? slides.filter((s) => parseVersionNum(s.version) > lastSeenNum)
    : slides;

  const [slide, setSlide] = useState(0);
  const { t } = useI18n();

  if (applicableSlides.length === 0) {
    // Proactively close if no slides are applicable
    setTimeout(onClose, 0);
    return null;
  }

  const currentSlide = applicableSlides[slide];

  const handleNext = () => {
    if (slide < applicableSlides.length - 1) {
      setSlide(slide + 1);
    } else {
      onClose();
    }
  };

  const handleBack = () => {
    if (slide > 0) {
      setSlide(slide - 1);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.45)', backdropFilter: 'blur(5px)' }}
    >
      <div
        className="glass animate-scale-in relative w-full max-w-lg p-8 shadow-2xl flex flex-col justify-between"
        style={{
          background: 'var(--bg-glass-hover)',
          border: '1px solid var(--border-glass)',
          backdropFilter: 'blur(30px)',
          minHeight: '420px',
        }}
      >
        <div>
          {/* Header */}
          <div className="mb-6">
            <div className="flex justify-between items-start">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-secondary">
                {t('welcome.releaseNotes')}
              </span>
              {slide < applicableSlides.length - 1 && (
                <button
                  onClick={onClose}
                  className="text-xs text-secondary hover:text-primary transition-colors hover:underline"
                >
                {t('welcome.skip')}
                </button>
              )}
            </div>
            <h2 className="text-xl font-bold mt-1 text-primary">{currentSlide.title}</h2>
            <p className="text-sm text-secondary">{currentSlide.subtitle}</p>
          </div>

          {/* Bullets List */}
          <div className="space-y-5">
            {currentSlide.bullets.map((b, i) => (
              <div key={i} className="flex gap-4 items-start">
                <div
                  className="flex items-center justify-center font-bold text-xs h-7 w-7 rounded-lg shrink-0"
                  style={{
                    background: 'color-mix(in srgb, var(--accent-blue) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-blue) 25%, transparent)',
                    color: 'var(--accent-blue)',
                  }}
                >
                  {i + 1}
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-primary">{b.title}</h4>
                  <p className="text-xs text-secondary mt-0.5 leading-relaxed">{b.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer controls */}
        <div className="mt-8 pt-4 border-t border-glass flex items-center justify-between" style={{ borderColor: 'var(--border-glass)' }}>
          {/* Dots Indicator */}
          <div className="flex gap-1.5">
            {applicableSlides.length > 1 && applicableSlides.map((_, i) => (
              <span
                key={i}
                className="h-1.5 rounded-full transition-all duration-150"
                style={{
                  width: slide === i ? '12px' : '6px',
                  background: slide === i ? 'var(--accent-blue)' : 'var(--text-secondary)',
                  opacity: slide === i ? 1 : 0.3,
                }}
              />
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            {slide > 0 && (
              <button
                onClick={handleBack}
                className="btn text-xs px-3.5 py-1.5"
              >
                {t('welcome.back')}
              </button>
            )}
            <button
              onClick={handleNext}
              className="btn btn-primary text-xs px-4 py-1.5"
            >
              {slide === applicableSlides.length - 1 ? t('welcome.getStarted') : t('welcome.next')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** All release information stays available without an automatic update popup. */
export function ReleaseNotes() {
  const { language } = useI18n();
  return <details className="data-note release-notes">
    <summary>{language === 'de' ? 'Versionshinweise' : 'Release notes'}</summary>
    <div className="data-note-body grid gap-4">
      {slides.map((item) => <section key={item.version}>
        <h3 className="font-semibold">{item.title}</h3>
        <p>{item.subtitle}</p>
        <ul className="mt-2 list-disc pl-4 space-y-1">
          {item.bullets.map((bullet) => <li key={bullet.title}><strong>{bullet.title}</strong> · {bullet.desc}</li>)}
        </ul>
      </section>)}
    </div>
  </details>;
}
