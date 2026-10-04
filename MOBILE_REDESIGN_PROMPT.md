# PROMPT: Komplette Überarbeitung der Mobile Web View — Insider & Whale Terminal

> Kopiere alles ab „AUFTRAG" in eine neue Claude-Code-Session im Projektordner `Insider`.

---

## AUFTRAG

Du überarbeitest die **Mobile-Ansicht der Web-Version** (`npm run build:web` → `dist-web/`, gehostet auf GitHub Pages) dieses Projekts **komplett und von Grund auf**. Nicht kosmetisch, nicht „ein paar Breakpoints nachziehen" — sondern ein durchdachtes, eigenständiges Mobile-Layout mit eigener Informationsarchitektur, eigenen Größen, eigenen Abständen und eigenen Interaktionsmustern.

**Nimm dir viel Zeit. Denke gründlich nach (ultrathink), bevor du Code schreibst.** Qualität vor Geschwindigkeit. Arbeite in Phasen, verifiziere jede Phase, und liefere am Ende einen Bericht.

Ziele, in dieser Reihenfolge:
1. **Es muss Sinn ergeben** — die richtige Information zuerst, keine verschwendete vertikale Fläche, klare Hierarchie auf 360 px Breite.
2. **Es muss perfekt aussehen** — konsistentes visuelles System, saubere Rhythmen, kein Umbruch-Chaos, keine abgeschnittenen Elemente.
3. **Es muss sich gut anfühlen** — Daumen-erreichbar, große Touch-Targets, flüssiges Scrollen, native App-Anmutung.

---

## 1. Projekt-Kontext (verifiziere das selbst, verlasse dich nicht blind darauf)

- **Stack:** React 18 + TypeScript + Vite + Tailwind CSS 3 + Zustand + Recharts.
- **Zwei Build-Targets aus derselben Renderer-Codebase:**
  - Electron-Desktop (`vite.config.ts`, `npm run dev` / `npm run dist`)
  - Statische Web-Version (`vite.config.web.ts`, `npm run build:web` → `dist-web/`, `base: './'`)
- **Der Seam ist `src/lib/ipc.ts`:** `isElectron`, `isWeb`. `isWeb` ist nur im Pages-Build true. Nutze diesen Seam, wenn Verhalten sich unterscheiden muss.
- **Daten:** Web liest statische JSONs aus `public/data/*.json` (geschrieben von GitHub Actions), via `src/lib/webApi.ts`.
- **Relevante Dateien:**
  ```
  index.html                                  ← viewport, CSP, Fonts
  tailwind.config.js
  src/styles/globals.css                      ← Design-Tokens, .glass, .btn, .input, globale table-Styles
  src/App.tsx
  src/components/Layout/Layout.tsx             ← Shell + Mobile-Drawer-State
  src/components/Layout/Sidebar.tsx            ← Nav, off-canvas < lg
  src/components/Layout/Header.tsx             ← Titel, Bell, VIX, Theme, Refresh
  src/components/Dashboard/Dashboard.tsx
  src/components/Dashboard/StatCards.tsx
  src/components/Dashboard/FilterBar.tsx
  src/components/Dashboard/SignalGrid.tsx
  src/components/Dashboard/SignalCard.tsx
  src/components/Detail/SignalModal.tsx        ← großes Detail-Modal
  src/components/Detail/InsiderTable.tsx
  src/components/Detail/OptionsFlow.tsx
  src/components/Detail/ScoreBreakdown.tsx
  src/components/Detail/InsiderAccuracyPanel.tsx
  src/components/Detail/ValuationSection.tsx
  src/components/News/NewsView.tsx
  src/components/Watchlist/WatchlistView.tsx
  src/components/History/HistoryView.tsx
  src/components/History/PerformancePanel.tsx
  src/components/Settings/*.tsx
  src/components/UI/*.tsx                      ← Badges, ScoreGauge, GlassCard, SourceHealth, icons
  ```

---

## 2. Harte Randbedingungen (nicht verhandelbar)

1. **Die Desktop-/Electron-Ansicht darf sich nicht verschlechtern.** Ab `lg` (1024 px) muss das Layout pixel-nah bleiben wie heute. Belege das mit Vorher/Nachher-Screenshots bei 1440×900.
2. **Keine Änderung an Business-Logik, Scoring, Scraper, Store-Selektoren oder Datenformaten.** Nur Präsentation, Layout, Styling, Navigation, Interaktion. Wenn eine Logikänderung unvermeidlich scheint: stoppen, im Bericht begründen, nicht heimlich machen.
3. **Content Security Policy in `index.html` respektieren.** Keine Inline-Skripte, keine neuen externen Hosts ohne die CSP korrekt mitzupflegen.
4. **`base: './'` bleibt** — keine absoluten Asset-Pfade, sonst bricht GitHub Pages.
5. **Keine neuen Runtime-Dependencies**, außer du kannst begründen, dass es ohne nicht sinnvoll geht (dann erst fragen bzw. im Bericht klar ausweisen). Framer Motion, UI-Kits o. ä. sind nicht erwünscht — CSS-Transitions reichen.
6. **TypeScript muss strikt durchlaufen:** `npm run typecheck` ohne Fehler. `npm run build:web` muss erfolgreich bauen.
7. **Kein Text-Content erfinden.** Labels dürfen gekürzt/umbenannt werden, aber keine Daten, Zahlen oder Aussagen erfinden.

---

## 3. Phase 0 — Bestandsaufnahme & Audit (bevor du irgendetwas änderst)

1. Lies **alle** oben gelisteten Dateien vollständig. Verschaffe dir ein echtes Bild, nicht nur Grep-Treffer.
2. Baue die Web-Version und starte sie lokal:
   ```
   npm run build:web && npx vite preview --outDir dist-web
   ```
   (oder `npm run dev:web`)
3. **Screenshot-Matrix mit Playwright** (Chromium ist bereits installiert, `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, kein `playwright install` nötig). Erzeuge für **jede** View (`dashboard`, `news`, `watchlist`, `history`, `settings`) **und** das geöffnete Signal-Modal je einen Full-Page-Screenshot bei:
   - 320×568 (iPhone SE 1, worst case)
   - 360×800 (Android-Median)
   - 390×844 (iPhone 14)
   - 430×932 (iPhone Pro Max)
   - 768×1024 (Tablet hoch)
   - 1440×900 (Desktop-Referenz)
   jeweils **Dark und Light Mode**, mit `deviceScaleFactor: 2` und `isMobile: true` / `hasTouch: true` für die Mobil-Größen.
   Ablage: `tmp/mobile-audit/before/<view>-<breite>-<theme>.png`.
4. **Sieh dir die Screenshots wirklich an** (Read-Tool auf die PNGs) und schreibe `tmp/mobile-audit/AUDIT.md`: eine nummerierte Liste **konkreter** Defekte, je mit Datei, Zeile, Screenshot-Referenz und Schweregrad (blocker / hoch / mittel / niedrig).
5. Prüfe zusätzlich messbar:
   - horizontales Overflow: gibt es Elemente mit `scrollWidth > clientWidth` am `document`? (per `page.evaluate` prüfen — Toleranz 0 px)
   - alle interaktiven Elemente: Bounding-Box < 44×44 px auflisten
   - Kontrastwerte für Text auf Glass-Flächen in beiden Themes

**Bekannte Startpunkte** — verifiziere jeden Punkt selbst, ergänze und korrigiere:

| # | Problem | Ort |
|---|---|---|
| 1 | `body { overflow: hidden }` + `height: 100%`-Kette: mobile Browser-URL-Leiste beschneidet den Viewport, kein `dvh`/`svh`, kein Safe-Area-Handling | `globals.css` |
| 2 | Viewport-Meta ohne `viewport-fit=cover`; keine `theme-color`, kein Web-App-Manifest, keine Apple-Touch-Icons | `index.html` |
| 3 | `.input` ist `text-sm` (14 px) → **iOS zoomt beim Fokussieren automatisch rein**. Muss auf Mobil ≥16 px sein | `globals.css`, Suchfeld in `Dashboard.tsx` |
| 4 | Navigation ist ein Hamburger-Drawer: zwei Taps zu jeder View, oben links (schlecht für Daumen), kein Focus-Trap, kein Body-Scroll-Lock, kein Swipe-to-close, kein `Escape` | `Layout.tsx`, `Sidebar.tsx` |
| 5 | Header trägt Titel + Untertitel + Bell + VIX + Theme + Refresh — auf 360 px gedrängt; `WebkitAppRegion: 'drag'` ist im Web sinnlos und kann Interaktion stören | `Header.tsx` |
| 6 | `StatCards` sind auf Mobil `grid-cols-1` → 4 große Karten übereinander, man scrollt an der eigentlichen Signal-Liste vorbei | `StatCards.tsx` |
| 7 | `FilterBar` hat 4 Segmented Controls + Toggle; `size="sm"` ergibt ~24 px hohe Tap-Targets und chaotische Umbrüche | `FilterBar.tsx` |
| 8 | `SignalCard` ist extrem dicht: `DetailRow` mit `h-4 text-xs`, Pills mit `text-[10px]` — auf Mobil unlesbar und untappbar | `SignalCard.tsx` |
| 9 | `SignalModal` ist ein zentriertes Dialog (`max-w-3xl`, `max-h-[95vh]`, `p-2`) statt eines Sheets; interne Grids und Tabellen sprengen die Breite | `SignalModal.tsx` |
| 10 | Globale `th`/`td`-Regeln mit `!important` (14 px horizontales Padding) erzwingen horizontales Overflow in allen Tabellen-Views | `globals.css` + `InsiderTable`, `OptionsFlow`, `ScoreBreakdown`, `HistoryView`, `PerformancePanel` |
| 11 | `backdrop-filter: blur(24px) saturate(190%)` auf vielen Flächen gleichzeitig → Scroll-Ruckeln auf Mid-Range-Android | `globals.css` |
| 12 | Google-Fonts-`@import` **innerhalb** der CSS-Datei (render-blocking, seriell nach dem CSS) + zwei Familien mit vielen Weights → langsamer First Paint auf Mobilfunk | `globals.css` / `index.html` |
| 13 | `hover:`-Zustände bleiben auf Touch-Geräten „kleben"; kein `:active`-Feedback, kein kontrolliertes `-webkit-tap-highlight-color` | überall |
| 14 | Recharts-Diagramme skalieren nicht sinnvoll auf schmale Breiten (Achsenbeschriftungen, Legenden) | `PerformancePanel`, `ScoreBreakdown`, `HistoryView` |
| 15 | Kein Pull-to-Refresh / kein sinnvoller Refresh-Pfad auf Web (Refresh-Button ist bei `isWeb` ausgeblendet — was fehlt dem Nutzer stattdessen?) | `Header.tsx` |

---

## 4. Phase 1 — Mobile Design-System definieren (erst festlegen, dann anwenden)

Schreibe `tmp/mobile-audit/DESIGN.md` und definiere darin **explizit** — danach hältst du dich im gesamten Code daran:

- **Breakpoint-Strategie:** klare Grenze mobile / tablet / desktop. Tailwind-Defaults sind `sm 640 / md 768 / lg 1024`. Lege fest, welcher Breakpoint „mobile" beendet, und begründe es. Vermeide es, Mobil-Regeln als Ausnahmen zu Desktop-Regeln zu schreiben — schreibe **mobile-first**, Desktop als Aufsatz.
- **Spacing-Skala für Mobil:** eine reduzierte, konsistente Leiter (z. B. 4/8/12/16/20/24). Seitenränder: ein Wert, überall gleich. Keine wilden `px-4 lg:px-8`-Einzelfälle mehr.
- **Type-Skala für Mobil:** Body, Label, Zahl/Mono, Überschrift H1–H3, Caption. Minimum-Größen festlegen: **Body ≥ 15 px, Caption ≥ 12 px, Eingabefelder ≥ 16 px.** Nichts unter 11 px, und 11 px nur für nicht-essenzielle Meta-Info.
- **Touch-Targets:** alles Klickbare ≥ 44×44 px effektiv (gerne kleineres Visual + vergrößerter Hit-Bereich via Padding/Pseudo-Element). Abstand zwischen Targets ≥ 8 px.
- **Radien, Schatten, Border:** eine Mobil-Variante des Glass-Systems, die weniger GPU kostet (reduzierter Blur, ggf. bei `prefers-reduced-transparency` bzw. auf kleinen Viewports komplett solide Flächen statt Blur).
- **Safe-Area-Tokens:** `env(safe-area-inset-*)` als CSS-Variablen, konsequent für Bottom-Nav, Sheets und Scroll-Padding.
- **Dichte-Modus:** entscheide bewusst, welche Informationen auf Mobil **primär** (immer sichtbar), **sekundär** (aufklappbar) oder **tertiär** (nur im Detail) sind. Schreibe diese Zuordnung pro View auf. Das ist der wichtigste Teil dieser Phase — Mobil ist eine Redaktions-, keine Skalierungsaufgabe.
- **Motion:** Dauer/Easing für Sheet-Auf, Tab-Wechsel, Press-Feedback. `prefers-reduced-motion` respektieren.

---

## 5. Phase 2 — Navigation & Shell neu bauen

- **Bottom Tab Bar** für Mobil statt Hamburger-Drawer: 5 Ziele (Alerts, News, Watchlist, History, Settings), Icon + Label, aktiver Zustand deutlich, Badge für Watchlist-Count, fixiert unten mit Safe-Area-Padding, über allem außer Sheets. Der Drawer/Sidebar bleibt ab `lg` unverändert.
- **Header radikal verschlanken:** eine kompakte Zeile. Untertitel auf Mobil weg oder in die Seite verschoben. Sekundäre Controls (VIX, Theme, Bell) in ein platzsparendes Muster überführen — z. B. Bell + Overflow-Menü, oder ein kompakter Statusstreifen. Header darf beim Scrollen kondensieren/verstecken (Scroll-Direction-abhängig), aber ohne Ruckeln und ohne Layout-Shift.
- **Scroll-Container sauber ziehen:** genau ein scrollender Bereich, `overscroll-behavior: contain`, `-webkit-overflow-scrolling` beachten, `100dvh`/`100svh` statt `100vh`, `scroll-padding-bottom` für die Tab Bar, unterer Content-Puffer damit nichts hinter der Bar verschwindet.
- **Filter-/Suchleiste** auf Mobil sticky unter dem Header, kollabiert zu einer Zeile mit Chips + „Filter"-Button, der ein Bottom Sheet mit allen Optionen öffnet. Aktive Filter als entfernbare Chips anzeigen (der Nutzer muss jederzeit sehen, warum die Liste leer ist).
- **`WebkitAppRegion`-Drag-Regionen** im Web-Build deaktivieren (`isWeb`).

---

## 6. Phase 3 — Views einzeln durcharbeiten

Für **jede** View: erst Zweck und Informationsprioritäten notieren, dann layouten. Arbeite eine View komplett fertig (inkl. Screenshot-Verifikation) bevor du die nächste beginnst.

**Dashboard / Alerts**
- StatCards auf Mobil kompakt: 2×2-Raster mit reduzierter Höhe **oder** eine horizontal snappende Kachelzeile. Sie dürfen maximal ~1/4 der ersten Bildschirmhöhe belegen — die Signal-Liste muss „above the fold" beginnen.
- `SignalCard` bekommt ein **eigenes Mobil-Layout**, keine gestauchte Desktop-Karte: Ticker + Score prominent, Conviction/Combo als klar lesbare Badges, maximal 3–4 Kennzahlen sichtbar, Rest über Antippen im Detail. Ganze Karte tappbar, Watchlist-Stern mit ausreichend großem eigenen Hit-Bereich und `stopPropagation`.
- Press-Feedback (`:active`-Scale/Tint) statt Hover-Effekt.
- Wenn die Liste lang werden kann: Windowing/Virtualisierung oder inkrementelles Rendern prüfen und begründen.

**Signal-Detail (`SignalModal`)**
- Auf Mobil ein **Full-Height Bottom Sheet** statt zentriertem Dialog: Drag-Handle, Sticky-Header mit Ticker + Schließen, scrollender Body, Safe-Area unten, Body-Scroll-Lock dahinter, Focus-Trap, `Escape`/Back-Geste schließt, Swipe-down schließt.
- Inhalt in klar getrennte, ggf. zusammenklappbare Abschnitte gliedern (Übersicht, Score-Breakdown, Insider-Trades, Options-Flow, Bewertung, News). Reihenfolge nach Nutzwert, nicht nach aktueller Codereihenfolge.
- **Alle Tabellen darin** unter dem Mobil-Breakpoint in Karten-/Definitionslisten überführen (eine Zeile = eine Karte mit Label-Wert-Paaren) — nicht einfach horizontal scrollen lassen. Wo eine Tabelle wirklich sinnvoll bleibt: eigener Scroll-Container mit klebender erster Spalte und sichtbarem Scroll-Hinweis.

**News**
- Feed-Layout für Mobil: klare Karten, Zeitstempel, Quelle, gute Zeilenlänge, Links mit ausreichender Trefferfläche.

**Watchlist**
- Kompakte Zeilen, Score sichtbar, Entfernen-Aktion eindeutig (Swipe-to-remove ist optional, dann aber mit sichtbarer Alternative).

**History / Performance**
- Charts: Mobil-Varianten mit reduzierten Ticks, kürzeren Achsenlabels, Legende unter dem Chart, sinnvoller Mindesthöhe, und Tooltip-Verhalten für Touch (Tap statt Hover).
- Tabellen wie oben in Karten überführen.

**Settings**
- Formularzeilen im iOS-Settings-Muster: Label links, Control rechts, ganze Zeile tappbar, gruppierte Abschnitte mit Überschriften, ausreichende Zeilenhöhe. Toggles und Inputs auf Touch-Größe.

**Globale Zustände**
- Leerzustände, Ladezustände (Skeletons), Fehlerzustände und der `SourceHealthBanner` müssen auf 320 px genauso sauber aussehen wie auf Desktop.

---

## 7. Phase 4 — Feel & Performance

- `-webkit-tap-highlight-color` kontrolliert setzen, `touch-action: manipulation` gegen 300 ms-Delay/Doppeltipp-Zoom.
- Hover-Effekte in `@media (hover: hover) and (pointer: fine)` kapseln.
- Blur-Flächen auf Mobil reduzieren; `will-change` nur gezielt; keine animierten `box-shadow`s in Scroll-Listen.
- Font-Loading: `@import` aus dem CSS heraus in `<link>` mit `preconnect` + `display=swap` verschieben, Weights auf die tatsächlich genutzten reduzieren.
- Bundle prüfen: `dist-web` Größe vorher/nachher; Recharts ggf. lazy laden für Views, die es nicht sofort brauchen.
- Erste sinnvolle Anzeige auf simuliertem „Slow 4G" messen (Playwright CDP-Throttling) und im Bericht ausweisen.
- Grundlegende PWA-Hygiene: `theme-color` je Theme, `apple-mobile-web-app-*`, Manifest + Icons, damit „Zum Home-Bildschirm" ordentlich aussieht (nur wenn es ohne CSP-/Pfad-Bruch geht).

---

## 8. Phase 5 — Verifikation (nicht optional)

1. `npm run typecheck` → 0 Fehler.
2. `npm run build:web` → erfolgreich. `npm run build` (Electron-Renderer) → erfolgreich.
3. **Screenshot-Matrix erneut** über exakt dieselbe Matrix wie in Phase 0, nach `tmp/mobile-audit/after/`. **Sieh dir jedes Bild an.**
4. Automatisierte Checks nach dem Umbau, für jede View und jede Mobil-Breite:
   - **kein horizontales Overflow** (`document.documentElement.scrollWidth <= clientWidth`)
   - **kein Tap-Target < 44×44 px** unter den interaktiven Elementen (Ausnahmen einzeln begründen)
   - **kein Text < 12 px**, kein Input < 16 px
   - kein Element, das hinter der Bottom Tab Bar oder in der Safe Area verschwindet
   - Modal/Sheet offen: Hintergrund scrollt nicht mit
5. Interaktions-Durchlauf per Playwright bei 390×844 mit `hasTouch`: jede Tab-Bar-Route öffnen, Filter-Sheet öffnen/schließen, Suche tippen, Signal-Karte öffnen, im Sheet scrollen, schließen, Watchlist togglen, Theme wechseln. Als GIF oder Screenshot-Serie dokumentieren.
6. **Desktop-Regressionsprüfung** bei 1440×900, Dark + Light, alle Views: Vorher/Nachher nebeneinander. Abweichungen erklären oder rückgängig machen.
7. Beide Themes durchgehen. Dark Mode ist der Standard-Anwendungsfall — dort muss es am besten aussehen.

---

## 9. Arbeitsweise

- Arbeite in **kleinen, thematisch sauberen Schritten**, nach jedem Schritt bauen und prüfen. Nicht 20 Dateien gleichzeitig anfassen und am Ende hoffen.
- **Keine Abkürzungen, keine Platzhalter, kein `TODO`, kein auskommentierter toter Code.** Was du anfasst, machst du fertig.
- Wenn du zwischen zwei Layout-Ansätzen schwankst: baue beide als Screenshot, vergleiche sie visuell, entscheide begründet — und dokumentiere die Entscheidung.
- Wenn du auf etwas stößt, das eine Logikänderung erfordern würde: **halte an und frage**, statt zu raten.
- Erfinde keine Daten für Screenshots; nutze den echten `public/data`-Stand bzw. den vorhandenen Sample-/Mock-Pfad und sage im Bericht, welchen.

## 10. Deliverables

1. Der umgesetzte Code im Repo.
2. `tmp/mobile-audit/AUDIT.md` — die Defektliste aus Phase 0.
3. `tmp/mobile-audit/DESIGN.md` — das festgelegte Mobil-Design-System.
4. `tmp/mobile-audit/before/` und `tmp/mobile-audit/after/` — die vollständigen Screenshot-Matrizen.
5. `tmp/mobile-audit/REPORT.md` — Abschlussbericht mit:
   - was geändert wurde, pro Datei, mit Begründung
   - Vorher/Nachher-Gegenüberstellung pro View
   - Ergebnistabelle der automatisierten Checks aus Phase 5
   - Bundle-Größe und Ladezeit vorher/nachher
   - bewusst **nicht** Geändertes und warum
   - verbleibende Risiken / offene Punkte

## 11. Akzeptanzkriterien (alle müssen erfüllt sein)

- [ ] Auf 360×800 ist die Signal-Liste ohne Scrollen angeschnitten sichtbar.
- [ ] Jede der 5 Views ist mit **einem** Tap erreichbar.
- [ ] Null horizontales Scrollen auf allen getesteten Mobil-Breiten, in allen Views, mit offenem und geschlossenem Detail.
- [ ] Kein Tap-Target unter 44×44 px; keine Eingabe zoomt auf iOS.
- [ ] Das Signal-Detail ist auf Mobil ein Sheet, das sich mit Swipe, Tap-außerhalb, Escape und Zurück-Geste schließen lässt, und der Hintergrund scrollt dabei nicht.
- [ ] Keine Tabelle erzeugt auf Mobil einen abgeschnittenen oder unlesbaren Zustand.
- [ ] Dark und Light Mode sind beide vollständig durchgestaltet.
- [ ] Bottom Tab Bar und Sheets respektieren die Safe Area auf iPhone-Geometrien.
- [ ] `npm run typecheck`, `npm run build:web` und `npm run build` laufen fehlerfrei durch.
- [ ] Desktop ab 1024 px sieht unverändert aus (belegt durch Screenshots).
- [ ] Der Abschlussbericht liegt vor und enthält alle geforderten Punkte.

**Beginne mit Phase 0. Ändere keine Zeile Code, bevor `AUDIT.md` und `DESIGN.md` stehen.**
