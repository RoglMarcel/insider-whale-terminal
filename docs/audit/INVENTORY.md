# INVENTORY — vollständige Dateiliste

Risikoklassen: **math** (rechnet Zahlen, die in den Score gehen) · **data** (Schema,
Persistenz, Migrationen) · **io** (Netz, Scraper, Prozessgrenze) · **ui** (Darstellung;
wird zu *math*, sobald Zahlen dargestellt werden) · **build** · **dev** (Debug-/
Einmalskripte ohne Produktionspfad).

Zeilenzahlen: `wc -l`, Stand des Audits.

## electron/ — Hauptprozess

| Zeilen | Datei | Zweck | Klasse |
|---:|---|---|---|
| 903 | `electron/scoring.ts` | Score-Kern: alle Faktoren, Multiplikatoren, Komposition, Politiker-Leg, Confidence | **math** |
| 1736 | `electron/database.ts` | SQLite-Schema, Migrationen, alle Queries, Outcome-Kandidaten, Trade-Fenster | **data** |
| 1358 | `electron/scraper/index.ts` | Orchestrator: Quellen-Pool, Dedup, Merge-Fenster, Anreicherung, Scoring-Aufruf, Persistenz | **io/math** |
| 792 | `electron/main.ts` | App-Lifecycle, IPC-Registrierung, CSV-Export, Signal-P&L, Auto-Updater, Scheduling | **io** |
| 303 | `electron/scraper/util.ts` | `parseMoney` / `parseDate` / `cleanTicker` / `sanitizeTradeAmounts`, Tabellenextraktion | **math/io** |
| 287 | `electron/webPublish.ts` | Desktop→Repo-DB-Kopie + git push | **data/io** |
| 282 | `electron/performance.ts` | In-App-Kalibrierung (Alpha vs. SPY, Tier-/Bucket-Statistik, IC10) | **math** |
| 270 | `electron/notifications.ts` | Desktop-Benachrichtigungen, Dedup gemeldeter Ticker | ui |
| 223 | `electron/auth.ts` | safeStorage-verschlüsselte Playwright-StorageStates je Plattform | io |
| 215 | `electron/scraper/optionsMap.ts` | Options-Tabellen-Mapping: Typ, Sentiment, DTE, OTM%, Vol/OI, Sweep | **math/io** |
| 210 | `electron/scraper/edgar.ts` | SEC-EDGAR-Atom + Form-4-XML-Parsing | io |
| 194 | `electron/scraper/sellside.ts` | OpenInsider-Verkäufe + EDGAR Form 144 (Kontext, kein Score) | io |
| 193 | `electron/scraper/barchart.ts` | Barchart Unusual Options (core-api + Shadow-DOM-Fallback) | io |
| 185 | `electron/scheduler.ts` | node-cron + Windows-Taskplaner-Sync | io |
| 167 | `electron/scraper/senatewatcher.ts` | House/Senate-STOCK-Act-Dumps (Congress-Fallback) | io |
| 162 | `electron/scraper/openinsider.ts` | OpenInsider-Screener (breiteste Insider-Quelle) | io |
| 159 | `electron/scraper/finviz.ts` | Finviz-Insider-Tabelle + Earnings von der Quote-Seite | io |
| 147 | `electron/scraper/gurufocus.ts` | GuruFocus-Insider-Summary (Cloudflare-Handling) | io |
| 468 | `electron/scraper/capitoltrades.ts` | Congress-Trades: BFF-API, Playwright, Quiver-Embed | io |
| 353 | `electron/scraper/browser.ts` | Playwright-Launch, Kontext, IndexedDB-Transfer, `withPage` | io |
| 277 | `electron/scraper/insiderHistory.ts` | Track-Record je Insider von OpenInsider | **math/io** |
| 264 | `electron/scraper/ceowatcher.ts` | Instagram-Captions (undatierte Quelle) | io |
| 123 | `electron/scraper/twitter.ts` | X/Twitter-News-Scraper (nur News-Tab) | io |
| 121 | `electron/scraper/insiderMap.ts` | Generisches Insider-Tabellen-Mapping | **math/io** |
| 121 | `electron/scraper/stockstats.ts` | stockanalysis.com Float/Short/Volumen + 52W-Drawdown | io |
| 119 | `electron/preload.ts` | contextBridge → `window.api` | io |
| 113 | `electron/scraper/quiverquant.ts` | Quiver-Insider-Feed inkl. Name/Titel-Split | io |
| 105 | `electron/scraper/insiderfinance.ts` | InsiderFinance-Flow (login-gated) | io |
| 97 | `electron/scraper/activist.ts` | SC 13D/13G-Radar über EDGAR-Atom | io |
| 94 | `electron/scraper/insidermonitor.ts` | Insider-Monitor-Digest | io |
| 79 | `electron/vix.ts` | VIX-Abruf (CBOE primär, Yahoo Fallback), 15-min-Polling, 2h-Verfall | **math/io** |
| 74 | `electron/scraper/marketbeatoptions.ts` | MarketBeat Options-Volumen (kein Premium) | io |
| 53 | `electron/ipc-channels.ts` | Kanalnamen (Single Source of Truth) | io |
| 31 | `electron/scraper/marketbeat.ts` | MarketBeat-Insider-Tabelle | io |
| 26 | `electron/scraper/secform4.ts` | SECForm4 all-buys | io |
| 26 | `electron/scraper/optionstrat.ts` | OptionStrat-Flow (login-gated) | io |

## src/ — Renderer

| Zeilen | Datei | Zweck | Klasse |
|---:|---|---|---|
| 1358 | `src/types/index.ts` | Geteilte Typen **und** reine Funktionen: Klassifikation, Freshness, Filter, Namensnormalisierung, Source-Health, Alert-Regeln, alle Konstanten | **math** |
| 796 | `src/lib/i18n.ts` | DE/EN-Übersetzungstabelle | ui |
| 533 | `src/components/Detail/SignalModal.tsx` | Detailmodal: Insider-Liste, Optionen, Chart, Performance | ui |
| 457 | `src/styles/globals.css` | Design-Tokens, Layout | ui |
| 337 | `src/components/Detail/ScoreBreakdown.tsx` | **Darstellung der Score-Mathematik** | **math/ui** |
| 316 | `src/components/Detail/InsiderTable.tsx` | Trades je Signal, Transaktions-Tiers | ui |
| 307 | `src/store/useStore.ts` | Zustand-Store, Filterpersistenz, IPC-Abos | ui |
| 279 | `src/components/Welcome/WelcomeModal.tsx` | Onboarding | ui |
| 272 | `src/components/Settings/SettingsPanel.tsx` | Einstellungen | ui |
| 259 | `src/components/Dashboard/SignalCard.tsx` | Signalkarte (Score, Badges, Volumen) | **math/ui** |
| 259 | `src/lib/sampleData.ts` | Mock-Signale für den Browser-Preview | dev |
| 247 | `src/components/News/NewsView.tsx` | News-Tab | ui |
| 201 | `src/components/Settings/AlertRules.tsx` | Alert-Regel-Editor | ui |
| 180 | `src/components/Layout/Header.tsx` | Kopfzeile, HIGH-Zähler, Scrape-Button | ui |
| 177 | `src/components/Watchlist/WatchlistView.tsx` | Watchlist + Score-Trend | ui |
| 172 | `src/lib/format.ts` | Zahl-/Datums-/Farbformatierung | **math/ui** |
| 167 | `src/components/Dashboard/FilterBar.tsx` | Filterleiste | ui |
| 160 | `src/components/Detail/InsiderAccuracyPanel.tsx` | Track-Record-Panel | **math/ui** |
| 156 | `src/components/UI/icons.tsx` | Inline-SVGs | ui |
| 149 | `src/components/UI/Sheet.tsx` | Bottom-Sheet | ui |
| 146 | `src/components/History/PerformancePanel.tsx` | Kalibrierungsreport-Anzeige | **math/ui** |
| 142 | `src/components/Settings/PlatformLogins.tsx` | Login-Verwaltung | ui |
| 137 | `src/App.tsx` | Routing/Shell | ui |
| 137 | `src/components/UI/UpdateNotification.tsx` | Update-Banner | ui |
| 136 | `src/lib/webApi.ts` | Web-Build-API über statisches JSON | io |
| 126 | `src/components/History/HistoryView.tsx` | Lauf-Historie | ui |
| 125 | `src/lib/mockApi.ts` | Mock-API | dev |
| 123 | `src/components/Dashboard/FilterSheet.tsx` | Mobile Filter | ui |
| 123 | `src/components/UI/SourceHealth.tsx` | Quellen-Gesundheit | ui |
| 112 | `src/components/Detail/OptionsFlow.tsx` | Options-Liste | **math/ui** |
| 112 | `src/components/Layout/Sidebar.tsx` | Navigation | ui |
| 107 | `src/components/Dashboard/Dashboard.tsx` | Dashboard-Komposition | ui |
| 95 | `src/components/Settings/ShadowScoring.tsx` | Shadow-Config-Editor | **math/ui** |
| 95 | `src/hooks/useSourceHealth.ts` | Health-Hook | ui |
| 93 | `src/components/Dashboard/StatCards.tsx` | Kennzahlkarten | ui |
| 88 | `src/components/Layout/BottomTabBar.tsx` | Mobile Tabs | ui |
| 86 | `src/components/UI/LanguageToggle.tsx` | Sprachschalter | ui |
| 79 | `src/components/UI/PoliticianBadges.tsx` | Politiker-Badges | ui |
| 79 | `src/components/UI/ScoreGauge.tsx` | Score-Ring | **math/ui** |
| 58 | `src/components/Watchlist/ScoreTrendChart.tsx` | Trendchart | ui |
| 56 | `src/components/Dashboard/SignalGrid.tsx` | Grid/Empty-State | ui |
| 46 | `src/hooks/useSignals.ts` | Gefilterte Signale + Kennzahlen | **math/ui** |
| 46 | `src/components/Layout/Layout.tsx` | Layout-Shell | ui |
| 40 | `src/hooks/useSwipeToDismiss.ts` | Touch-Geste | ui |
| 30 | `src/components/UI/EarningsChip.tsx` | Earnings-Chip | ui |
| 29 | `src/components/UI/ConvictionBadge.tsx` | Tier-Badge | ui |
| 27 | `src/components/UI/VixIndicator.tsx` | VIX-Anzeige | ui |
| 22 | `src/hooks/useI18n.ts` | i18n-Hook | ui |
| 20 | `src/components/UI/GlassCard.tsx`, `src/hooks/useWatchlist.ts` | Karte / Watchlist-Hook | ui |
| 18 | `src/lib/ipc.ts` | Electron/Web/Mock-Seam | io |
| 17 | `src/components/UI/FreshnessBadge.tsx` | Frische-Badge | ui |
| 15 | `src/components/UI/ComboBadge.tsx` | Combo-Badge | ui |
| 10 | `src/main.tsx`, `src/types/global.d.ts`, `src/vite-env.d.ts` | Entry / Ambient-Typen | build |

## scripts/

| Zeilen | Datei | Zweck | Klasse |
|---:|---|---|---|
| 1304 | `scripts/backtest-components.ts` | Komponentenweiser Backtest (IC je Faktor, IS/OOS-Split) | **math** |
| 983 | `scripts/backtest-opportunistic.ts` | Cohen–Malloy–Pomorski-Backtest (routine vs. opportunistic) | **math** |
| 387 | `scripts/verify-scoring.ts` | Regressions-Schranke des Score-Modells | **math** |
| 216 | `scripts/scrape-web.ts` | Headless-Runner für CI → `public/data/*.json` | io |
| 213 | `scripts/backtest.ts` | Tier-Backtest | **math** |
| 204 | `scripts/publish-web.ts` | Web-Publish unter Electron | io |
| 193 | `scripts/label-outcomes.ts` | Outcome-Labeling (SPY-relatives Alpha) | **math/io** |
| 119 | `scripts/verify-db.ts` | DB-Roundtrip-Prüfung | data |
| 108 | `scripts/analyze-score.ts` | Score-Kalibrierung (Spearman-IC + Buckets) | **math** |
| 82 | `scripts/publish-data.ts` | Publish-Fastpath aus der Repo-DB | io |
| 67 | `scripts/electron-stub.ts` | `electron`-Shim für Node-Runner | build |
| 6 | `scripts/congress-lib.ts` | Re-Export-Stub | dev |
| ≤ 82 | 30 weitere `test-*` / `inspect-*` / `debug-*` / `verify-*` / `scrape-*` / `dump-*` / `query-*` | Einmalige Selektor- und Endpunkt-Erkundungen; kein Produktionspfad, nicht in `package.json` verdrahtet | dev |

## Wurzel + CI

| Datei | Zweck | Klasse |
|---|---|---|
| `.github/workflows/scrape.yml` (151 Z.) | **Einziger** Workflow: scrape → publish → Pages → DB-Commit. Kein typecheck, kein Test, kein Build-Gate | build |
| `README.md` (53 KB) | Produktdoku inkl. Abschnitt „Scoring Model" | doc |
| `MOBILE_REDESIGN_PROMPT.md` (19 KB) | Historisches Arbeitsdokument | doc |
| `package.json` | Skripte + Abhängigkeiten | build |
| `index.html` | Shell + CSP | build |
| `vite.config.ts` / `vite.config.web.ts` | Electron- / Web-Build | build |
| `tsconfig.json` / `tsconfig.node.json` | Zwei Typecheck-Projekte | build |
| `electron-builder.json`, `build/installer.nsh` | Paketierung | build |
| `tailwind.config.js`, `postcss.config.js` | Styling-Build | build |
| `data/insider-tracker.db` (28,6 MB) | **Echte, nicht reproduzierbare Historie** | **data** |
| `public/` | Icons, Manifest, `intro.mp4` (20,6 MB) | build |
