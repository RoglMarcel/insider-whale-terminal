# COVERAGE — Ledger

✅ = gelesen **und** auditiert · ⏭ = bewusst übersprungen (mit Grund) · ❌ = offen

**Am Ende dieses Audits: kein ❌.**

---

## electron/ (math / data / io — vollständig gelesen)

| Status | Datei | Anmerkung |
|---|---|---|
| ✅ | `electron/scoring.ts` | vollständig, Zeile für Zeile; jede Formel in MATH.md |
| ✅ | `electron/database.ts` | vollständig: Schema, Migrationen, alle 60+ Queries, Query-Pläne geprüft |
| ✅ | `electron/scraper/index.ts` | vollständig: Dedup, Merge, Anreicherung, Politiker-Aggregate, Persistenz, Metrik-Check |
| ✅ | `electron/scraper/util.ts` | vollständig; `parseMoney`/`parseDate`/`sanitizeTradeAmounts` numerisch geprüft |
| ✅ | `electron/main.ts` | vollständig: Fenster/CSP-Kontext, alle 40 IPC-Handler, CSV, P&L, Updater, Scheduling |
| ✅ | `electron/performance.ts` | vollständig; F31-Protokoll, Selektionsbias gefunden |
| ✅ | `electron/vix.ts` | vollständig |
| ✅ | `electron/webPublish.ts` | vollständig: Repo-Auflösung, ATTACH-Kopie, Identitätsspalten, git-Pfad |
| ✅ | `electron/auth.ts` | vollständig: safeStorage-Kodierung, Cookie-Rewrite, mtime-Cache |
| ✅ | `electron/notifications.ts` | vollständig; alle 6 Notify-Pfade + Dedup |
| ✅ | `electron/scheduler.ts` | vollständig: node-cron + schtasks-Sync + DST-Umrechnung |
| ✅ | `electron/preload.ts` | vollständig; gegen `InsiderTrackerAPI` abgeglichen |
| ✅ | `electron/ipc-channels.ts` | vollständig |
| ✅ | `electron/scraper/insiderMap.ts` | vollständig; `\|\| 'P'`-Default gefunden |
| ✅ | `electron/scraper/optionsMap.ts` | vollständig; Sentiment-Fallbackkette, OTM-Vorzeichen, DTE |
| ✅ | `electron/scraper/openinsider.ts` | vollständig; `cnt=500`-Deckel, harte Fehlerpolitik |
| ✅ | `electron/scraper/edgar.ts` | vollständig; Atom-Dedup, Form-4-XML, nur Code `P` |
| ✅ | `electron/scraper/finviz.ts` | vollständig; Ticker-Reparaturpfad als E2 belegt |
| ✅ | `electron/scraper/quiverquant.ts` | vollständig; `splitNameTitle`, Richtungs-Guard |
| ✅ | `electron/scraper/insiderHistory.ts` | vollständig; Alpha-Berechnung als korrekt bestätigt (frühere Vermutung widerlegt) |
| ✅ | `electron/scraper/browser.ts` | vollständig; Launch-Flags, Stealth, IndexedDB-Transfer, `withPage` |
| ✅ | `electron/scraper/capitoltrades.ts` | vollständig; `amountToMidpoint` gegen STOCK-Act-Bänder geprüft, Ticker-Pfade |
| ✅ | `electron/scraper/senatewatcher.ts` | vollständig; Ticker-Denylist ad hoc |
| ✅ | `electron/scraper/sellside.ts` | vollständig; CIK→Ticker-Map, Form-144-Atom, Klassen-Alias |
| ✅ | `electron/scraper/activist.ts` | vollständig; Titel-Regex als wahrscheinliche Ausfallursache |
| ✅ | `electron/scraper/stockstats.ts` | vollständig |
| ✅ | `electron/scraper/insidermonitor.ts` | vollständig; `mapTradeType`-Default |
| ✅ | `electron/scraper/gurufocus.ts` | vollständig; CF-Erkennung, harte Fehlerpolitik |
| ✅ | `electron/scraper/barchart.ts` | vollständig; core-api-Mapper + DOM-Fallback |
| ✅ | `electron/scraper/marketbeatoptions.ts` | vollständig; kein Premium ⇒ kann kein Whale-Gate auslösen |
| ✅ | `electron/scraper/insiderfinance.ts` | vollständig |
| ✅ | `electron/scraper/optionstrat.ts` | vollständig |
| ✅ | `electron/scraper/marketbeat.ts` | vollständig |
| ✅ | `electron/scraper/secform4.ts` | vollständig |
| ✅ | `electron/scraper/ceowatcher.ts` | vollständig; undatierte Quelle, Caption-Parsing |
| ✅ | `electron/scraper/twitter.ts` | vollständig; News-Pfad, single-flight |

## src/ — math-relevant (vollständig)

| Status | Datei | Anmerkung |
|---|---|---|
| ✅ | `src/types/index.ts` | vollständig, Zeile für Zeile; alle reinen Funktionen + Konstanten in MATH.md |
| ✅ | `src/components/Detail/ScoreBreakdown.tsx` | vollständig; drei Darstellungsfehler (E22) |
| ✅ | `src/hooks/useSignals.ts` | vollständig; Header/Grid beschreiben dieselbe Menge |
| ✅ | `src/store/useStore.ts` | vollständig |
| ✅ | `src/lib/format.ts` | vollständig; alle Formatierer gegen `null`/`NaN` geprüft |
| ✅ | `src/lib/webApi.ts` | vollständig |
| ✅ | `src/lib/ipc.ts` | vollständig |
| ✅ | `src/components/Dashboard/Dashboard.tsx` | vollständig (Sortierung, Suche) |

## src/ — UI (gezielt gelesen: Zahlendarstellung, Zustandsduplikate)

| Status | Datei | Anmerkung |
|---|---|---|
| ✅ | `SignalCard.tsx`, `StatCards.tsx`, `ScoreGauge.tsx`, `ConvictionBadge.tsx`, `FreshnessBadge.tsx`, `EarningsChip.tsx`, `ComboBadge.tsx`, `PoliticianBadges.tsx`, `VixIndicator.tsx` | gezielt auf Zahlen/Schwellen geprüft; alle beziehen Grenzwerte aus `@/types` bzw. `format.ts`, keine dupliziert |
| ✅ | `InsiderAccuracyPanel.tsx`, `OptionsFlow.tsx`, `PerformancePanel.tsx`, `ShadowScoring.tsx` | gezielt: stellen Modellzahlen dar |
| ✅ | `FilterBar.tsx`, `FilterSheet.tsx`, `SignalGrid.tsx`, `Header.tsx`, `SourceHealth.tsx` | gezielt: Filter-/Zustandsduplikate — keine gefunden (alles über `useSignals`) |
| ⏭ | `SignalModal.tsx`, `InsiderTable.tsx`, `WatchlistView.tsx`, `ScoreTrendChart.tsx`, `HistoryView.tsx`, `NewsView.tsx`, `SettingsPanel.tsx`, `AlertRules.tsx`, `PlatformLogins.tsx`, `WelcomeModal.tsx`, `Sidebar.tsx`, `Layout.tsx`, `BottomTabBar.tsx`, `Sheet.tsx`, `GlassCard.tsx`, `icons.tsx`, `LanguageToggle.tsx`, `UpdateNotification.tsx` | reine Präsentation ohne eigene Zahlenlogik; überflogen und als solche bestätigt. Kein Audit-Ziel nach Abschnitt 2 des Auftrags („bei ui reicht gezieltes Lesen — außer die Datei stellt Zahlen dar") |
| ⏭ | `src/lib/i18n.ts` (796 Z.) | reine Übersetzungstabelle; auf fehlende Schlüssel geprüft (Typecheck deckt das ab) |
| ⏭ | `src/styles/globals.css` | Design-Tokens |
| ⏭ | `src/hooks/useI18n.ts`, `useWatchlist.ts`, `useSwipeToDismiss.ts`, `useSourceHealth.ts` | trivial bzw. reine Weiterleitung |
| ⏭ | `src/lib/mockApi.ts`, `src/lib/sampleData.ts` | nur Vorschau-Daten, kein Produktionspfad |
| ✅ | `src/App.tsx`, `src/main.tsx`, `src/types/global.d.ts`, `src/vite-env.d.ts` | vollständig (klein) |

## scripts/

| Status | Datei | Anmerkung |
|---|---|---|
| ✅ | `scripts/verify-scoring.ts` | vollständig; Lücken benannt (keine Schwellenpaare, keine Invarianten) |
| ✅ | `scripts/analyze-score.ts` | vollständig; Spearman + SE-Problem |
| ✅ | `scripts/label-outcomes.ts` | vollständig; Alpha-Definition, Look-ahead-Prüfung |
| ✅ | `scripts/publish-data.ts` | vollständig; JSON-Payload auf Geheimnisse geprüft |
| ✅ | `scripts/electron-stub.ts` | vollständig |
| ✅ | `scripts/verify-db.ts` | vollständig; 5 Typfehler gefunden |
| ✅ | `scripts/scrape-web.ts`, `publish-web.ts`, `verify-scrape.ts` | gelesen; CI-Pfad |
| ⏭ | `scripts/backtest.ts`, `backtest-components.ts` (1304 Z.), `backtest-opportunistic.ts` (983 Z.) | Statistikprotokoll und Ergebnisse gelesen; **nicht** Zeile für Zeile auditiert. Grund: sie sind Analysewerkzeuge ohne Produktionspfad, benötigen zum Ausführen Live-Kursdaten, und ihre Befunde liegen bereits als Kommentare im Scoring-Code vor. **Im Bericht als ungeprüft ausgewiesen.** |
| ⏭ | 24 × `test-*.ts` / `inspect-*.ts` / `debug-*.ts` / `dump-links.ts` / `query-scores.ts` / `scrape-*.ts` / `check-auto-scrape.ts` / `verify-congress.ts` / `verify-logins-live.ts` / `verify-twitter.ts` / `congress-lib.ts` | einmalige Erkundungsskripte, in keinem `package.json`-Skript verdrahtet, kein Produktionspfad. **Trotzdem in den Typecheck aufgenommen** — dabei 18 Typfehler gefunden und behoben; `test-valuation-fetch.ts` importiert ein gelöschtes Modul und wurde entfernt |

## Wurzel / CI / Build

| Status | Datei | Anmerkung |
|---|---|---|
| ✅ | `.github/workflows/scrape.yml` | vollständig; fehlendes Qualitäts-Gate (E9) |
| ✅ | `package.json` | vollständig; `analyze:score`-Runner-Fehler (E10) |
| ✅ | `tsconfig.json`, `tsconfig.node.json` | vollständig; Abdeckungslücke (E8) |
| ✅ | `vite.config.ts`, `vite.config.web.ts` | vollständig |
| ✅ | `index.html` | vollständig; CSP geprüft |
| ✅ | `electron-builder.json`, `build/installer.nsh` | vollständig |
| ✅ | `tailwind.config.js`, `postcss.config.js` | vollständig |
| ✅ | `data/insider-tracker.db` | Schema + Inhalt analysiert (16 Tabellen, 10 Abfrageläufe); **Backup vor jedem Zugriff**, alle Zugriffe `readonly` |
| ⏭ | `README.md` (53 KB) | Abschnitt „Scoring Model" vollständig gegen den Code geprüft und korrigiert; übrige Kapitel (Installation, Quellenliste, Troubleshooting) überflogen |
| ⏭ | `MOBILE_REDESIGN_PROMPT.md` | historisches Arbeitsdokument ohne Codebezug |
| ⏭ | `public/` | Assets (Icon, Manifest, `intro.mp4`); Ausschluss aus dem Web-Build verifiziert |
| ⏭ | `package-lock.json` | generiert |
