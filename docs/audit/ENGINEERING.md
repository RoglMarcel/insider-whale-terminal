# ENGINEERING — Befunde außerhalb der Mathematik

Schweregrade: **S1** = falsche Daten oder stiller Datenverlust · **S2** = Korrektheit
unter Randbedingungen / Wartbarkeit / fehlende Absicherung · **S3** = Kosmetik,
Performance, Dokumentation.

---

## S1 — falsche Daten / stiller Verlust

### E1 · Korrupte Ticker gelangen ungeprüft in Datenbank und Score
`cleanTicker()` entfernt nur unerlaubte Zeichen und schneidet auf 12 Stellen ab.
Es gibt **keine Formprüfung**. Real in der DB gefunden:

| Ticker | Zeilen | Herkunft |
|---|---:|---|
| `-` | 1 | `quiverquant` — Insider-Trade über **$6.000.000** |
| `NVDAEARNINGS` | 5 | `insiderfinance` — Optionskontrakt über $5,4M, **Score 17,3** |
| `3.MONTHMATURE` | 5 | `capitoltrades` |
| `GLASFUNDS` | 5 | `capitoltrades` |
| `TE1` | 36 | `capitoltrades` |
| `DDGICA`, `FFCNCA`, `GGLIBA`, `GGLIBK`, `LLILAK` | je 4–6 | `finviz` (verdoppelter Anfangsbuchstabe) |

76 von 10541 Signalzeilen. Eine Formregel `^[A-Z]{1,5}([.-][A-Z]{1,2})?$`
verwirft auf den realen Daten **ausschließlich** diese Zeilen.

### E2 · Finviz verdoppelt weiterhin den Anfangsbuchstaben bei Mehrklassen-Tickern
Die Reparatur in `finviz.ts` liest den echten Ticker aus dem Quote-Link, keyed
auf den **exakten Zelltext**. `extractTable().getDeepText` fügt bei `DIV`/`P`
`\n` ein, `td.textContent` (die Key-Quelle) nicht → bei mehrzeilig gerenderten
Zellen greift die Reparatur nicht. Ergebnis: `BRK-A` → `BBRK-A`, `DGICA` →
`DDGICA`, `GLIBA` → `GGLIBA`, `GLIBK` → `GGLIBK`, `LILAK` → `LLILAK`,
`FCNCA` → `FFCNCA`.
Beide Formen existieren gleichzeitig in `insider_trades` — derselbe Trade wird
auf zwei Ticker aufgeteilt.

### E3 · Anteilsklassen werden nicht kanonisiert
`BRK.B`, `BRK-A`, `BBRK-A`, `BBRK-B` stehen nebeneinander in `signals`.
`BIG_PLAYERS` enthält `'BRK.B'` → `isBigPlayer('BRK-B') === false`.
`politician_trades` liefert `BRK.B` und `LEN-B`, Finviz liefert `BRK-A`.
Yahoo (Preisabruf in `label-outcomes.ts`, `performance.ts`, `main.ts`) erwartet
die **Bindestrich**-Form; `stockanalysis.com` die **Punkt**-Form. Es gibt keine
Umrechnung → Signale auf Klassenaktien werden nie gelabelt.

### E4 · Fehlerhafte Zeilen werden 30 Tage lang wiedereingespielt
`insider_trades` ist das Gedächtnis der Pipeline (`TRADE_WINDOW_DAYS = 30`).
Eine einmal eingeschleuste Fehlzeile erscheint in **jedem** folgenden Scrape,
auch nachdem der Scraper repariert wurde. `backfillInsiderTradesFromSignals()`
zieht zusätzlich alte, fehlerhafte Zeilen aus der Signalhistorie nach.
Es gibt keinen Bereinigungspfad.

### E5 · Chronisch tote Quellen werden nie gemeldet
`computeSourceHealth` flaggt bewusst keine „chronically-empty" Quellen. Über die
letzten 14 Läufe (aus `scrape_log`):

| Quelle | Zeilen je Lauf | Status |
|---|---|---|
| `gurufocus` | **−1** in jedem Lauf | hart fehlgeschlagen → wird korrekt geflaggt |
| `marketbeat` | **0** in jedem Lauf | **stumm** — nie geflaggt |
| `activist` | **0** in jedem Lauf | **stumm** — nie geflaggt |
| `edgar` | 0–6 (bei `FILING_LIMIT = 60`) | auffällig niedrig, nie geflaggt |

Das rollende Fenster umfasst 20 Läufe. Eine Quelle, die länger als 20 Läufe tot
ist, hat Median 0 und gilt dauerhaft als „chronisch leer" — der Ausfall wird
**unsichtbar**, statt sichtbar zu bleiben.

### E6 · `mapInsiderTable` setzt bei fehlender Typspalte `'P'` (Open-Market-Buy)
```ts
let transactionType = cleanText(cell(row, idx.type)) || 'P';
```
`extractFirstTable` fällt auf `'table'` (irgendeine Tabelle der Seite) zurück.
Findet die Header-Heuristik die Typspalte nicht, wird **jede Zeile** als Kauf
mit vollem Modifier 1,0 gewertet. Dasselbe Muster in
`insidermonitor.ts:mapTradeType` (unbekannter Code → `'P - Purchase'`).
Das widerspricht direkt der Zusicherung in `classifyTransaction`
(„Unknown / empty — do NOT assume a buy"). Aktuell nicht ausgelöst (nur 4
verschiedene Typstrings in der gesamten DB), aber eine Header-Umbenennung bei
`secform4` oder `marketbeat` genügt.

---

## S2 — Korrektheit unter Randbedingungen, fehlende Absicherung

### E7 · Kein Test-Runner, keine Unit-Tests
Ist-Zustand: `scripts/verify-scoring.ts` ist die einzige Absicherung
(387 Zeilen, eigene `check`/`approx`-Helfer). Keine Schwellenprüfung von beiden
Seiten, keine Invarianten, keine Randfälle, kein Snapshot.

### E8 · `npm run typecheck` deckt `scripts/` überhaupt nicht ab
`tsconfig.json` → nur `src`. `tsconfig.node.json` → nur `electron` +
`vite.config.ts`. Damit sind **~5000 Zeilen** in `scripts/` (inklusive
`verify-scoring.ts`, `analyze-score.ts`, `label-outcomes.ts`, drei Backtests)
und `vite.config.web.ts` ungeprüft. Bei Aufnahme in den Typecheck erscheinen
**18 echte Typfehler** in 6 Dateien, u. a. in `verify-db.ts`.

### E9 · CI hat kein Qualitäts-Gate
`.github/workflows/scrape.yml` ist der einzige Workflow: scrape → publish →
Pages → DB-Commit. Kein `typecheck`, kein Test, kein `verify:scoring`, kein
Desktop-Build. Ein Push, der das Scoring bricht, wird deployed.

### E10 · `npm run analyze:score` schlägt lokal fehl
Deklariert als `… && node tmp/analyze-score.cjs`, aber `better-sqlite3` ist
lokal gegen die Electron-ABI gebaut → `ERR_DLOPEN_FAILED`
(`NODE_MODULE_VERSION 125` vs. `115`). In CI funktioniert es (dort wird
`npm rebuild better-sqlite3 --build-from-source` für Node gebaut).
Das Skript ist damit genau dort unbenutzbar, wo es am meisten gebraucht wird.

### E11 · `scoreTicker` mutiert seinen Input und ist nicht idempotent
Siehe MATH M47/M48. Der Orchestrator ruft bei aktiver Shadow-Config
`scoreTicker(agg)` und danach `scoreTicker(agg, shadowConfig)` auf **demselben
Objekt** auf. Gemessen: 1. Aufruf 57,1 → 2. Aufruf 0.
Blast Radius auf den realen Daten: 0 von 10943 Trades (latent).

### E12 · `NaN` erreicht `finalScore`
Siehe MATH M45. `getVixMultiplier(NaN)` und `getTrackRecordMultiplier(NaN)`
liefern `NaN`; `clamp(NaN, 0, 100) === NaN`; `getConvictionLevel(NaN)` gibt
`'LOW'` zurück. Heute defensiv (alle Quellen validieren mit `Number.isFinite`),
aber es gibt keine Schranke, die das garantiert.

### E13 · Kein Rejection-Handler an der Prozessgrenze
`main.ts` registriert 40 `ipcMain.handle`-Kanäle, davon mehrere `async`
(`scraperStart`, `signalsGetPerformance`, `earningsFetch`,
`performanceRecompute`, `insiderGetTrackRecord`). Ein Wurf propagiert als
abgelehnter Promise zum Renderer — dort gibt es keinen zentralen Catch
(`useStore.refresh` fängt nur um `api.scraper.start`). Es gibt weder
`process.on('unhandledRejection')` noch `process.on('uncaughtException')`.

### E14 · Optionskontrakte werden über Quellgrenzen doppelt gezählt
`mergeOptionsActivity` nimmt `source` in den Merge-Key auf. Derselbe Kontrakt
von zwei Anbietern bleibt zweimal erhalten und wird in `scoreOptionsDetailed`
als zwei Prints mit geometrischem Decay gewertet (1,5× statt 1×).
Gemessen: 17 von 1210 Kontrakten (1,4 %), 17 von 455 betroffenen Signalen —
z. B. `QQQ|call|735|2026-08-17` von `insiderfinance` ($120k) und `optionstrat`
($118k).

### E15 · `performance.ts` wählt je Ticker-Tag den höchsten Score
`if (!prev || r.score > prev.score)` — über mehrere Läufe desselben Tages wird
der beste genommen, nicht der erste. Optimistischer Schätzer.
`label-outcomes.ts` macht es korrekt (`MIN(id)`).

### E16 · Zukunftsdatierte Trades gelten als maximal frisch
`getFreshnessMultiplier(-399) = 1,0`, und `detectCombo` prüft `age <= 14`, was
für negative Alter ebenfalls wahr ist. Ein um Jahre falsch geparstes Datum
liest sich damit als das frischeste Signal im System.

### E17 · Unicode-Minus wird nicht als Vorzeichen erkannt
`parseMoney` prüft `trimmed.startsWith('-')` (ASCII) und Klammern. Ein
typografisches Minus `−` (U+2212) oder ein En-Dash `–`, wie ihn viele
Finanzseiten rendern, wird ignoriert → der Betrag wird positiv gelesen.
Relevant für `pctFrom52wHigh` und alle Prozentspalten.

### E18 · `PRAGMA` mit interpolierten Bezeichnern
`database.ts:299` und `webPublish.ts:100` interpolieren Tabellen-/Schema-Namen
in `PRAGMA`-Statements. Beide Aufrufstellen verwenden ausschließlich
Code-Literale, also kein aktuelles Injektionsrisiko — aber es sind die einzigen
zwei Stellen im Repo, an denen SQL nicht parametrisiert ist. Alle 60+ übrigen
Queries sind sauber parametrisiert (geprüft).

### E19 · `safeStorage`-Fallback speichert Sessions im Klartext
`auth.ts:encodeState` schreibt bei nicht verfügbarer OS-Verschlüsselung ein
`RAW:`-Blob mit den kompletten Session-Cookies und warnt nur auf der Konsole.
Sitzungscookies sind passwortäquivalent. Der Nutzer erfährt es nicht in der UI.
(Der bekannte `userData`-Fallstrick — falscher Pfad ⇒ Quelle fehlt still in
`sourceBreakdown` — ist davon unabhängig und in der README dokumentiert.)

### E20 · `getWatchlist()` ist N+1
Ruft `getSignalByTicker` je Eintrag auf. Bei kleinen Watchlists irrelevant,
strukturell aber vermeidbar.

---

## S3 — Performance, Kosmetik, Dokumentation

### E21 · `signals.json` ist 643 KB und enthält den vollen Detailstand
`publish-data.ts` schreibt `JSON.stringify(getLatestSignals())` — inklusive
`rawTrades`, `optionsActivity`, `politicianTrades`, vollständigem `breakdown`
und allen `notes`. Der Web-Client lädt alles beim ersten Rendern, obwohl die
Listenansicht davon fast nichts braucht.
**Sicherheitsprüfung: unbedenklich** — geprüft, es sind keine Session-,
Cookie- oder Login-Daten enthalten; nur öffentliche Marktdaten und URLs.

### E22 · Anzeige der Score-Mathematik ist nicht ehrlich
`ScoreBreakdown.tsx`:
- zeigt `rawScore / maxPossibleRaw` (z. B. „170 / 2855") direkt neben dem
  Endscore. Der Score wird aber über `100·raw/(raw+105)` gebildet — bei raw 170
  sind das 61,8, nicht 6 %. Die Darstellung suggeriert eine lineare
  Normalisierung, die es seit v1.0.46 nicht mehr gibt.
- zeigt für Politiker-Combos „`+45 / +25 / +20 Bonus`". Das sind die
  **Legacy**-Werte; live wirken `×1,25 / ×1,18 / ×1,15`, und nur wenn
  `norm ≥ 50`.
- zeigt `optionsTimingMultiplier` überhaupt nicht, obwohl er im Breakdown steht
  und das Options-Leg bis ×2,0 skaliert.

### E23 · Kommentar-Drift
`MAX_OPTIONS_SCORE_TOTAL` (`// 157.248`, real 227,136) an zwei Stellen;
`MAX_POSSIBLE_RAW` JSDoc (`≈ 2662.15`, real 2855,04); README „≈ 2126";
`shrunkAccuracy`-Beispiel („nahe 0,74", real 0,7326);
Notiztext „Earnings in 1–5 days" für einen Zweig, der `0 ≤ d ≤ 5` abdeckt.

### E24 · Zwei tote/kaputte Dev-Skripte
`scripts/test-valuation-fetch.ts` importiert `../electron/scraper/valuation` —
das Modul wurde mit dem Fair-Value-Feature entfernt. `scripts/congress-lib.ts`
ist ein 6-zeiliger Re-Export-Stub ohne Aufrufer.

### E25 · `MAX_VIX_MULTIPLIER` hartkodiert neben konfigurierbarem `vixCap`
`scoring.ts:35` setzt 1,15 fest, während `getVixMultiplier` den Cap aus
`ScoringConfig` bezieht. Eine Shadow-Config mit anderem `vixCap` macht
`MAX_POSSIBLE_RAW` still falsch.

### E26 · `renderer` läuft sauber isoliert (Positivbefund)
`contextIsolation: true`, `nodeIntegration: false`, kein
`enableRemoteModule`, `setWindowOpenHandler` verweigert In-App-Navigation und
öffnet extern. CSP in `index.html` ist restriktiv
(`default-src 'self'`, kein `unsafe-eval`, `connect-src 'self' ws:`).
`sandbox: false` ist nötig, weil das Preload `node:`-Module braucht — mit
`contextIsolation` vertretbar.

### E27 · Query-Pläne sind in Ordnung (Positivbefund)
Alle 12 Hauptqueries geprüft (`EXPLAIN QUERY PLAN`). Vorhandene Indizes werden
genutzt; die verbleibenden `SCAN`s sind Voll-Aggregationen
(`MAX(id) GROUP BY ticker`, `getScoreOutcomeRows`), für die es keinen besseren
Plan gibt. Bei 10541 bzw. 4474 Zeilen unkritisch.

### E28 · Migrationen sind korrekt gebaut (Positivbefund)
PRAGMA-basierte Spaltenprüfung statt `ADD COLUMN IF NOT EXISTS`, additiv,
idempotent, in `try/catch` je Spalte. `initDatabase` legt vor jeder Migration
eine Tageskopie unter `userData/backups/` an und behält 5 Stände — inklusive
`-wal`/`-shm`-Sidecars. `snapshotDatabase` nutzt korrekt die Online-Backup-API
statt eines Dateikopie (WAL-sicher).

---

## Nachtrag — Befunde, die erst bei der Umsetzung sichtbar wurden

### E2 (eskaliert) · Die Finviz-Ticker-Korruption betrifft 20,8 % aller Ticker
Bei der ersten Sichtung fielen nur die sechsstelligen Mehrklassen-Symbole auf
(`DDGICA`, `GGLIBA`, `LLILAK`, `FFCNCA`, `BBRK-A`, `BBRK-B`). Die Messung der
Score-Verteilung förderte dann Namen wie `DDGXX`, `LLWAY`, `RREFI`, `NNTHI`,
`IINV` zutage — und eine Prüfung gegen die SEC-Registry ergab:

| | Anzahl |
|---|---:|
| Ticker mit doppeltem Anfangsbuchstaben | 165 von 689 |
| davon **echt** (in `company_tickers.json`) | 21 (`AAPL`, `AAT`, `BBBY`, `QQQ`, `LLY`, `KKR`, `CCL`, `VVV`, `WWW`, …) |
| davon **korrupt** (entdoppelte Form registriert) | **143 (20,8 % aller Ticker)** |
| unklar (weder noch) | 1 (`AAXIA`) |

Alle 143 stammen aus `finviz`, alle wurden im Lauf vom 22.08.2026 gesehen —
der Fehler ist also nicht historisch, sondern laufend. Betroffene Signale
bekommen keine Marktkapitalisierung, keine Earnings und keine Kursreihe zum
Labeling: sie fallen still aus der gesamten Anreicherung heraus.

Behoben in zwei Schichten: die positionelle Reparatur direkt im Finviz-Scraper
(E2 oben) und, unabhängig von dessen DOM, `repairDoubledTicker()` gegen die
SEC-Registry. Die Musterprüfung allein genügt nicht — 21 echte Symbole
beginnen mit einem doppelten Buchstaben.

### E29 · Ein reines Analyse-Skript migrierte die committete Historien-DB
`initDatabase()` kannte nur den Schreibpfad (Backup → `CREATE TABLE` →
Migrationen → Trade-Backfill). `npm run analyze:score` hat damit
`data/insider-tracker.db` tatsächlich verändert — die neue Spalte
`scrape_log.data_quality` wurde beim Lesen angelegt. Inhaltlich ging nichts
verloren (gegen das Audit-Backup geprüft: 10.541 `signals`, 4.474
`signal_outcomes`, identische Prüfsummen über `score`, `alpha` und die
Breakdown-Längen), aber eine Auswertung darf die einzige nicht reproduzierbare
Datei des Projekts nicht anfassen. Behoben: `initDatabase(path, { readonly: true })`.

### E30 · `npm install --ignore-scripts` zerstört die lokale Werkzeugkette
Beim Hinzufügen von Vitest mit `--ignore-scripts` wurden Electrons
Binary-Download **und** der `better-sqlite3`-Build für die Electron-ABI
übersprungen; npm hatte beide Pakete neu ausgepackt. Danach schlug jedes
`ELECTRON_RUN_AS_NODE=1 electron …` fehl. Wiederhergestellt mit
`node node_modules/electron/install.js` und `npx electron-builder install-app-deps`.
**Für dieses Repo gilt: niemals mit `--ignore-scripts` installieren** — der
`postinstall` ist der Schritt, der die native Werkzeugkette überhaupt herstellt.
(Im CI-Workflow ist `--ignore-scripts` dagegen korrekt: dort wird die DB nie
geöffnet, und es spart den Electron-Download.)

### E31 · Eine eingefügte Regex wurde still zu einem Steuerzeichen
Die Rückreferenz in `repairDoubledTicker` (`/^([A-Z])\1/`) wurde beim
automatisierten Einfügen zu `/^([A-Z])\x01/` verstümmelt. Die Funktion
kompilierte, typisierte sauber und reparierte **nichts**. Aufgefallen ist das
ausschließlich durch die neu geschriebenen Unit-Tests. Ohne die Tests wäre der
wichtigste Datenintegritätsfix dieses Audits als No-op ausgeliefert worden.
