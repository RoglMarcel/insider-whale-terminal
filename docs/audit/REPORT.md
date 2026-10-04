# REPORT — Audit des Scoring-Modells und der Pipeline

Branch `claude/project-audit-formulas-code-d8547e` · Basis `a87e93c` · 9 Commits ·
53 Dateien · +4115 / −297 Zeilen.

---

## 1. Der wichtigste Befund zuerst

**Der zentrale empirische Ausgangspunkt des Auftrags hält der Prüfung nicht stand.**

Behauptet war: *„der Score ist über alles gerechnet invertiert — IC(10d) ≈ −0,079
(t ≈ −3,0), IC(20d) ≈ −0,149 (t ≈ −4,5)"*. Beide Zahlen sind rechnerisch korrekt
reproduziert. Sie messen nur nicht, was sie zu messen scheinen — aus zwei
voneinander unabhängigen Gründen:

**(a) Der Datensatz mischt zwei Populationen.** 55 % der gelabelten 10-Tage-Zeilen
(794 von 1442) enthalten **keinerlei Score-Inhalt**: kein wertbarer Insider-Trade,
kein Optionsfluss. Sie entstehen, weil der Orchestrator für *jeden* Ticker mit
einem einzigen Kongress-Kauf in 90 Tagen ein Aggregat anlegt, während der
Live-Politiker-Score für Einzel-Prints 0 zurückgibt. Diese Zeilen sind ein anderes
Universum — 53 % `BIG_PLAYERS` gegenüber 11 % bei echten Signalen — und sie
besetzen den gesamten unteren Score-Bereich.

**(b) Die Beobachtungen sind nicht unabhängig.** `SE ≈ 1/√n` setzt das voraus.
Gemessene Intra-Cluster-Korrelation nach Ticker: ρ = 0,45 (10 d), ρ = 0,77 (20 d).

Beides korrigiert:

| Horizont | Menge | n | n_eff | IC | t (naiv) | **t (clusterbereinigt)** | 95 %-KI |
|---|---|---:|---:|---:|---:|---:|---|
| 10 d | ALLE | 1442 | 606 | −0,079 | −3,00 | **−1,95** | [−0,158; 0,001] |
| 10 d | **mit Inhalt** | 648 | 344 | −0,039 | −1,00 | **−0,73** | [−0,145; 0,067] |
| 20 d | ALLE | 917 | 330 | −0,149 | −4,51 | **−2,70** | [−0,253; −0,042] |
| 20 d | **mit Inhalt** | 437 | 190 | −0,015 | −0,31 | **−0,20** | [−0,157; 0,128] |

Der 10-Tage-Befund ist nach Clusterbereinigung **nicht signifikant**. Der
20-Tage-Befund überlebt sie auf der Gesamtmenge, **verschwindet aber vollständig**,
sobald die inhaltsleeren Zeilen ausgeschlossen werden.

**Was ehrlich bleibt — und schwächer ist als der Ausgangsbefund:**

> Innerhalb echter Signale **rankt der Score nicht** — der IC ist von Null nicht
> unterscheidbar. Und das Insider-Universum lag in diesem Regime über 20 Tage
> ~1,7 % hinter SPY.

Hinzu kommt ein Befund, der jede Aussage über *dieses* Modell einschränkt: der
gesamte gelabelte Datensatz wurde unter einer **anderen Freshness-Regel** erzeugt
(`null → 1,0` statt `null → Floor`; die Änderung kam am 22.08.2026, die Labels
enden am 16.08.2026). 50–63 % der gespeicherten Breakdowns tragen
`signalAgeDays = null` **und** `freshnessMultiplier = 1,0`.

---

## 2. Gefunden und behoben

### Mathematik / Score-Kern

| # | Befund | Beleg | Blast Radius |
|---|---|---|---|
| 1 | **`NaN` erreichte `finalScore`** — `getVixMultiplier(NaN)` und `getTrackRecordMultiplier(NaN)` gaben `NaN`, `clamp(NaN)` ist `NaN`, `getConvictionLevel(NaN)` gab still `'LOW'` | `tmp/q/math.ts` M17 | 0 (defensiv) |
| 2 | **`scoreTicker` war nicht idempotent** — `sanitizeTradeAmounts` gab für (1 Stück, $5M) einen Preis von 5.000.000/Stück zurück, oberhalb seiner *eigenen* Schranke, weil die Ableitung `p = v/s` nach der Preisprüfung stand. Zurückgeschrieben in den Input ließ das den 2. Aufruf die Zeile verwerfen: 57,1 → 0. Der Orchestrator ruft genau zweimal auf | `math3.ts` P1/P2 | 0 von 10.943 Trades (latent) |
| 3 | **Kontextmultiplikatoren kehrten die Richtung um** — bei negativer Beinsumme plus Politiker-Score ergab ein Track Record von 0,20 **Score 73,1**, einer von 0,85 dagegen **69,2**. Analog Valuation (überbewertet 72,6 > unterbewertet 69,8) | `math.ts` M11/M12 | ~0 (7 von 689 Tickern haben bärisch dominierten Flow) |
| 4 | **Nicht-Monotonie in der Insiderzahl** — Nenner = alle Insider, Cluster-Zähler = letzte 30 Tage. Zwei *zusätzliche* echte, alte Kleinkäufe senkten den Score 39,4 → 31,7 | `math3.ts` P4 | 1 von 689 (SNES, −3,0) |
| 5 | **Gemischte Vergleichsoperatoren** — `getDollarVolumePoints` nutzte auf der obersten Sprosse `>` statt `>=` (exakt $5.000.000 → 14 Punkte, ein Cent mehr → 20). `baseOptionPoints` ebenso auf drei Sprossen | `math2.ts` N3 | 20 Trades bzw. 0 Optionen |
| 6 | **Zukunftsdatierte Trades galten als maximal frisch** (`fresh = 1,0` bei ageDays = −399) | `math3.ts` P5 | 0 |
| 7 | **`classifyTransaction` wandte den SEC-Code-Fallback auf Prosa an** — `"Acquisition"` → Stock Award (0), `"Automatic Buy"` → Stock Award (0), `"Cash Purchase"` → Conversion (0,2) | `math.ts` M14 | 0 (nur 4 Typstrings in der DB) |
| 8 | `parseMoney` erkannte nur ASCII-`-` als Vorzeichen, nicht U+2212 / Dashes | Test | Anzeige |
| 9 | `MAX_VIX_MULTIPLIER` hartkodiert neben konfigurierbarem `vixCap` | Code | Doku |

**Gesamtwirkung aller Score-Fixes auf echten Daten, Uhr eingefroren: 1 von 689
Signalen ändert sich (SNES 10,8 → 7,8), 0 Tier-Wechsel.** Genau das, was
Korrektheitsfixes tun sollen.

### Datenintegrität — der schwerste Befund

**20,8 % aller Ticker waren korrupt.** Finviz rendert einen Logo-Chip in die
Ticker-Zelle, dessen Fallback-Buchstabe Teil von `textContent` ist. Gegen die
SEC-Registry geprüft:

| | Anzahl |
|---|---:|
| Ticker mit doppeltem Anfangsbuchstaben | 165 von 689 |
| davon **echt** (`AAPL`, `AAT`, `BBBY`, `QQQ`, `LLY`, `KKR`, …) | 21 |
| davon **korrupt** (`AALK`→`ALK`, `AARE`→`ARE`, `CCORZ`→`CORZ`, …) | **143 (20,8 %)** |
| unklar | 1 |

Alle 143 aus `finviz`, alle im Lauf vom 22.08.2026 gesehen — laufend, nicht
historisch. Betroffene Signale bekommen keine Marktkapitalisierung, keine
Earnings und keine Kursreihe zum Labeling; sie fallen still aus der gesamten
Anreicherung. Behoben in zwei Schichten: positionelle Reparatur im Scraper
(unabhängig vom Zelltext, der der Grund für das Versagen der alten Reparatur war)
**und** `repairDoubledTicker()` gegen die SEC-Registry, unabhängig von Finviz' DOM.

Weiter behoben: Müll-Ticker (`-` mit einem $6.000.000-Trade aus Quiver;
`NVDAEARNINGS` als $5,4M-„Call" mit Score 17,3 aus InsiderFinance;
`3.MONTHMATURE`, `GLASFUNDS`, `TE1` aus Capitol Trades), fehlende
Anteilsklassen-Kanonisierung (`BRK.B` vs. `BRK-A`; `isBigPlayer('BRK-B')` war
`false`), quellenübergreifende Options-Doppelzählung (17 von 1210 Kontrakten),
und der stille `'P'`-Default für eine fehlende Transaktionstyp-Spalte.

### Messung

- `analyze:score` **lief lokal überhaupt nicht** (hart `node` gegen einen
  Electron-ABI-Build). Neuer Runner wählt die Runtime, die das native Modul laden
  kann.
- Der Report ist jetzt **partitioniert** (mit Inhalt / inhaltsleer / alle), weist
  **n_eff und t_cluster** aus, zeigt **95 %-Intervalle** je Bucket, misst
  **Bucket-Monotonie** als Zahl, macht einen **zeitlichen** Out-of-Sample-Split und
  sagt in einer Lesehilfe, was die Zahlen *nicht* belegen.
- **Faktor-Aktivität** wird ausgewiesen: VIX 0,0 %, Valuation 0,0 %,
  Korroboration 0,0 % — ausdrücklich als „nicht widerlegt, nie testbar". **Korrektur: der Valuation-Wert war ein Messartefakt, siehe §9.**
- `performance.ts` behielt je Ticker-Tag den **höchsten** Score über mehrere Läufe
  desselben Tages statt des ersten — Selektionsbias zugunsten des gemessenen
  Modells. Jetzt der erste.
- Yahoo erwartet Anteilsklassen mit Bindestrich; ohne Umrechnung fand kein
  Klassenaktien-Signal je eine Kursreihe. `yahooTicker()` an allen vier
  Abrufstellen.
- Ein reines Analyseskript öffnete die committete Historien-DB **schreibend** und
  migrierte sie. Jetzt `readonly`.

### Absicherung (vorher: nichts davon vorhanden)

- **Vitest + 296 Tests**: jede reine Funktion, jede Schwelle von *beiden* Seiten,
  Randfälle (0, negativ, `undefined`, `NaN`, leer), die in Kommentaren
  dokumentierten Beispielrechnungen.
- **Invarianten als Tests** über 418 Aggregate (18 absurde + 400 zufällige, fester
  Seed): `finalScore` endlich und in [0, 100]; kein `NaN`/`Infinity` im Breakdown;
  jeder Multiplikator exakt 1,0 bei neutralem Input; Determinismus bei fixierter
  Uhr; keine Input-Mutation; Options-Score < 2× bester Print; Monotonie in Track
  Record, Valuation, VIX, Insiderzahl, Kaufgröße, Optionsprämie und (fallend) Alter.
- **Golden-File** mit 15 fixierten Aggregaten (`npm run golden:update`).
- **CI-Gate** (`ci.yml`): typecheck, test, `verify:scoring`, beide Builds bei jedem
  Push/PR — vorher existierte *nur* `scrape.yml`, ohne jede Prüfung vor dem Deploy.
- **Typecheck deckt jetzt `scripts/` und `tests/` ab** (~5000 vorher ungeprüfte
  Zeilen). Dabei 18 echte Typfehler gefunden und behoben.
- **Datenqualitäts-Monitor** je Lauf und Quelle: Zeilen, unparsbare Ticker/Daten,
  fehlende Werte, unbekannte Typen, fehlende Rollen, reparierte Symbole —
  persistiert, ab 20 % gewarnt, als „unbrauchbar"-Spalte in der Source-Health-UI.

### Ehrlichkeit der Darstellung

`ScoreBreakdown.tsx` stellte den Score an drei Stellen falsch dar: `raw /
maxPossibleRaw` neben dem Endwert (6 % angezeigt, wo der Score 61,8 war), die
**Legacy**-Pauschalen +45/+25/+20 für ein Modell, das gegatete Soft-Multiplikatoren
anwendet, und der Options-Timing-Multiplikator wurde nie gezeigt. Alle drei
behoben und im Browser gegen echte Daten verifiziert (Signal MSFT zeigt jetzt
`Rohwert 27 → Sättigung ×100/(raw+105) → Endwert 20.6` und
`POLITICIAN_OPTIONS (× 1.15, gesperrt, Basis muss ≥ 50 sein)`).

Der README-Abschnitt „Scoring Model" beschrieb an sechs Stellen etwas anderes als
der Code (u. a. `finalScore` als Legacy-Formel, `MAX_POSSIBLE_RAW ≈ 2126` statt
2855,04, „VIX boost when VIX > 25" statt einer Rampe ab 20) und ist neu geschrieben.

---

## 3. Produktentscheidungen (vom Nutzer beantwortet)

| Frage | Entscheidung | Umsetzung |
|---|---|---|
| 37 % inhaltsleere Signalzeilen | **nicht mehr persistieren** | umgesetzt; 184 von 689 Tickern entfallen, **alle mit Score 0, alle LOW** — kein Signal mit Inhalt betroffen |
| Korroborations-Gate (nie ausgelöst) | **so lassen, sichtbar als inaktiv** | Faktor-Aktivität im Report; keine Zahl geändert |
| Zwei Skalen in `getDollarVolumePoints` | **erst dokumentieren, dann entscheiden** | dokumentiert (README + MONOTONICITY.md); die drei Varianten sind vermessen (siehe unten) |

---

## 4. Offen — bewusst nicht behoben

### 4.1 Die zwei Skalen in `getDollarVolumePoints` (H1)

> **Umgesetzt am 2026-08-23 als Variante C — siehe §10.**

Der Faktor trägt **60,0 % der Varianz** von `log(insiderRaw)` und wechselt je nach
Datenverfügbarkeit die Einheit. Derselbe $5M-CEO-Kauf: **57,1 (WATCH)** ohne
bekannte Marktkapitalisierung, **8,7 (LOW)** bei 2 Billionen. Abdeckung 65,9 %.

Gemessene Varianten:

| Variante | Wirkung |
|---|---|
| **A — unverändert** | 34 % aller Signale bleiben auf der Ersatzskala |
| **B — Leiter an 1 Mrd. ankern** (`≥$200k → 10`, `≥$50k → 5`) | **74 Ticker ändern sich, 3 Tier-Wechsel**, Verschiebungen bis +25 Punkte |
| **C — Abdeckung erhöhen** | **166 bewertete Signale** wechseln auf die cap-relative Leiter, **keine Konstante geändert** |

**Einschätzung:** C ist die einzige Variante, die den Faktor *besser misst*, statt
die Ersatzmessung anders zu skalieren. B wäre nach Regel 4 zulässig (interne
Konsistenz zweier Konstanten — zwei der vier Sprossen implizieren bereits 1 Mrd.,
die anderen 2 bzw. 2,5 Mrd.), verschiebt aber Scores flächig, ohne dass etwas
gemessen besser würde.

### 4.2 Warum diese Fixe *nicht* gemacht wurden

| Befund | Warum nicht behoben |
|---|---|
| Chronisch tote Quellen (`marketbeat` 0 Zeilen in jedem Lauf, `activist` ebenso, `gurufocus` −1) | Die Ursache liegt außerhalb des Codes (Cloudflare-Block, vermutlich geänderte Seitenstruktur). Ohne Live-Zugriff auf die Seiten wäre jede Änderung Raten. `activist` liefert seit 14 Läufen 0 Zeilen, obwohl 13D/13G-Filings täglich vorkommen — das ist mit an Sicherheit grenzender Wahrscheinlichkeit ein Parserfehler, aber der Beleg fehlt. **Der Datenqualitäts-Monitor macht das jetzt sichtbar; die Reparatur braucht einen Lauf gegen die echten Seiten.** |
| `computeSourceHealth` sieht chronisch leere Quellen nie | Die Regel ist bewusst so gebaut (sonst würde jede deaktivierte Quelle Alarm schlagen). Eine Änderung müsste zwischen „nie aktiv" und „lange tot" unterscheiden — dafür fehlt ein Feld „zuletzt gesund". Als Vorschlag, nicht als Eingriff. |
| Fehlerhafte Zeilen bleiben 30 Tage in `insider_trades` | Ein Bereinigungspfad ist ein destruktives Migrationsskript auf der Historien-DB. Regel 6 des Auftrags verlangt dafür einen Backup-Schritt und Bedacht; die neuen Gates verhindern *neue* Fehlzeilen, die alten laufen binnen 30 Tagen aus dem Fenster. |
| Kein `unhandledRejection`-Handler in `main.ts` | Ein globaler Handler in einem Electron-Hauptprozess ändert das Fehlerverhalten der gesamten App. Das ist eine Architekturentscheidung, kein Audit-Fix. |
| `signals.json` mit 643 KB | Eine Aufteilung in Listenfelder + Details-on-demand ändert den Web-API-Vertrag (`webApi.ts`, `publish-data.ts`, `scrape-web.ts`) und damit das Ladeverhalten der Seite. Zu groß für „nebenbei", und der beschlossene Wegfall der inhaltsleeren Signale reduziert die Nutzlast bereits um ~27 %. |
| Doppelzählung Rang / Finanz-Insider-Bonus (ein CFO bekommt Gewicht 8 **und** ×1,3) | Reale Doppelzählung, aber die Korrektur ist eine Modelländerung ohne Beleg. Als Shadow-Kandidat vorgeschlagen. |
| Politiker-Score-Skala (20 Politiker = 1500 Punkte ≈ `MAX_INSIDER_RAW`, ohne geometrischen Decay wie beim Options-Leg) | Dieselbe Klasse: strukturelle Asymmetrie, aber jede Begrenzung ist eine gewählte Zahl. Dokumentiert in FACTORS.md #12. |
| Earnings-Timing als möglicher Blackout-Window-Artefakt | Sachlich der stärkste Zweifel an einem aktiven Faktor (Insider dürfen 1–5 Tage vor Earnings meist gar nicht handeln). Testbar über den Anteil der Fälle mit weit auseinanderliegendem `tradeDate`/`filingDate` — gehört ins Kalibrierungs-Panel, nicht in eine Konstante. |

---

## 5. Was weiterhin unbelegt ist

- **Kein einziger Score-Faktor hat nachgewiesene Prognosekraft.** Der beste
  verfügbare Test (IC innerhalb echter Signale) ist von Null nicht
  unterscheidbar, in allen drei Horizonten.
- **VIX, Valuation und die Korroborationsmultiplikatoren sind nie aktiv gewesen**
  (0,0 % über 10.541 Signale). Sie sind **nicht widerlegt** — sie waren nie
  testbar. Keiner wurde entfernt oder umparametriert. **Für Valuation trifft das nicht zu — der Faktor HAT gefeuert, siehe §9.**
- **Alle Schwellen bleiben unbelegt**: 1/1,5/2/3 beim Cluster, 1,8/1,5/1,3 beim
  Insider-Timing, 2,0/1,6/1,3 beim Options-Timing, die Prämienleiter, die
  Committee-Multiplikatoren, das 14-Tage-Combofenster, die 250k-Schwelle. Sie sind
  plausibel und intern konsistent — mehr nicht.
- **Die vier Options-Teilmultiplikatoren** (Sweep, DTE, OTM, Vol/OI) sind
  untereinander korreliert und potenzieren teilweise dieselbe Eigenschaft. Die
  Datenlage (6,9 % der Zeilen haben überhaupt einen Options-Score) reicht für eine
  Messung nicht aus.
- **Ob kurze DTE Konviktion oder Lotterieschein ist** und **ob tief-OTM stärker
  zählen sollte**, bleibt offen. Beides sind bewusst offene Fragen, keine
  Versäumnisse.

**Nicht geprüft:** `scripts/backtest.ts`, `backtest-components.ts` (1304 Z.) und
`backtest-opportunistic.ts` (983 Z.) wurden auf Protokoll und Ergebnisse gelesen,
aber **nicht Zeile für Zeile auditiert**. Sie haben keinen Produktionspfad,
brauchen zum Ausführen Live-Kursdaten, und ihre Befunde liegen bereits als
Kommentare im Scoring-Code. Das ist der einzige nennenswerte Abstrich an der
Vollständigkeit (siehe COVERAGE.md).

---

## 6. Verifikation

Alle Gates grün, Ausgaben in `tmp/audit/verify/`:

```text
npm run typecheck    → 0 Fehler (jetzt inkl. scripts/ und tests/)
npm test             → 296 / 296 grün, 7 Dateien, ~1,0 s
npm run verify:scoring → ALL SCORING CHECKS PASSED
npm run build        → dist/ + dist-electron/ gebaut
npm run build:web    → dist-web/ gebaut (306 kB js, 93 kB gzip)
npm run analyze:score → läuft (vorher: ERR_DLOPEN_FAILED)
```

**Score-Verteilung vorher/nachher** (689 Ticker, Uhr auf 2026-08-22T18:00Z
eingefroren, damit der Zeitverfall die Messung nicht überlagert):

```text
vorher   Tiers {LOW: 668, WATCH: 21}  Mittelwert 11.54  Median 5.4
         0-9:425 10-19:113 20-29:65 30-39:41 40-49:24 50-59:16 60-69:4 70-79:1
nachher  Tiers {LOW: 668, WATCH: 21}  Mittelwert 11.53  Median 5.4
         0-9:426 10-19:112 20-29:65 30-39:41 40-49:24 50-59:16 60-69:4 70-79:1

geänderte Scores: 1 von 689 · Tier-Wechsel: 0
größte Verschiebung: SNES 10.8 → 7.8 (−3.0, Fix #4)
```

Zusätzlich entfallen durch die beschlossene Produktänderung 184 von 689 Tickern
(26,7 %) — **alle mit Score 0, alle Tier LOW**.

**IC vorher/nachher:** unverändert. Das ist zu erwarten und wichtig festzuhalten:
die Fixes ändern 1 von 689 Scores, und die gelabelten Outcomes stammen ohnehin aus
Signalen, die unter dem alten Modell erzeugt wurden. **Dieses Audit hat den IC
nicht verbessert und beansprucht das auch nicht.** Was es verbessert hat, ist die
*Messung*: die Zerlegung aus Abschnitt 1 war vorher nicht sichtbar.

**Datenintegrität:** Vor dem ersten Zugriff wurde eine Kopie der DB angelegt
(`tmp/audit/backup/`). Endstand gegen diese Kopie geprüft: 10.541 `signals`,
4.474 `signal_outcomes`, identische Prüfsummen über `score`, `alpha` und die
Breakdown-Längen. Einzige Änderung: die additive Spalte `scrape_log.data_quality`
(siehe ENGINEERING E29).

---

## 7. Zwei Anmerkungen zur Arbeitsweise

**Ein eigener Befund war falsch.** Ich hatte in FACTORS.md notiert, `bestAccuracy3m`
stamme aus der 1-Monats-Spalte der Quelle. Beim vollständigen Lesen von
`insiderHistory.ts` stellte sich das als unzutreffend heraus: die Kennzahl ist eine
echte 90-Kalendertage-Rendite auf adjustierten Schlusskursen minus SPY, mit
korrekter Behandlung fehlender Benchmark-Fenster und dokumentiertem
Survivorship-Bias. Korrigiert.

**Ein Fix wäre als No-op ausgeliefert worden.** Die Rückreferenz in
`repairDoubledTicker` (`/^([A-Z])\1/`) wurde beim automatisierten Einfügen still zu
einem Steuerzeichen verstümmelt. Die Funktion kompilierte, typisierte sauber — und
reparierte nichts. Aufgefallen ist das ausschließlich durch die neu geschriebenen
Unit-Tests, also durch genau das, was diesem Projekt vorher gefehlt hat.

---

## 8. Hinweise für den nächsten Schritt

1. **`tmp/` ist in `.gitignore`.** Diese Audit-Dokumente sind damit nicht Teil des
   Commits. Wenn sie im Repo bleiben sollen, gehören sie nach `docs/audit/`.
2. **Nie mit `--ignore-scripts` installieren** (außer im CI-Job). Der `postinstall`
   ist der Schritt, der Electron und den `better-sqlite3`-Build überhaupt
   herstellt; ohne ihn ist die lokale Werkzeugkette zerstört (siehe E30).
3. **Der nächste sinnvolle Datenschritt ist nicht mehr Kalibrierung, sondern mehr
   Regime.** Bei n_eff ≈ 190–816 aus einem einzigen Marktmonat ist jede
   Modellentscheidung, die sich auf den IC stützt, Kurvenfitten — unabhängig davon,
   wie das Vorzeichen ausfällt.
4. **Die nächste echte Ertragsquelle ist Datenabdeckung, nicht Gewichtung:**
   `marketCap` fehlt bei 34 % der Signale, drei Faktoren waren nie aktiv, und bis
   heute wurde jedes fünfte Signal auf einen nicht existierenden Ticker gebucht.

---

## 9. Nachtrag (2026-08-23) — Re-Scoring der gelabelten Historie

Anlass: `signal_outcomes.score` ist zum Signalzeitpunkt eingefroren, die
Freshness-Regel hat sich danach geändert (`null → 1,0` wurde zu `null → Floor`),
und 50–63 % der gespeicherten Breakdowns tragen genau diese Form. Der Verdacht
war, dass die gesamte IC-Auswertung ein überholtes Modell misst.

**Umgesetzt:** `npm run rescore:history` (`scripts/rescore-history.ts`, read-only).
Es baut den Komposit-Score aus den gespeicherten Komponenten neu auf, **beweist die
Rekonstruktion zuerst gegen die gespeicherten Werte** und tauscht erst dann die
Freshness-Regel. `scoreTicker` wird bewusst NICHT erneut ausgeführt: `marketCap`,
`vix` und `bestAccuracy3m` wurden nie persistiert — ein „Replay" müsste sie
erfinden.

### 9.1 Der Verdacht war richtig gedacht und empirisch gegenstandslos

| Horizont | Zeilen | rekonstruiert | von der Regel betroffen | Score geändert | Tier gewechselt |
|---|---:|---:|---:|---:|---:|
| 5 d | 2115 | 100,0 % | 1086 (51,3 %) | **0** | 0 |
| 10 d | 1442 | 100,0 % | 794 (55,1 %) | **0** | 0 |
| 20 d | 917 | 100,0 % | 480 (52,3 %) | **0** | 0 |

Grund: von den 794 betroffenen 10-Tage-Zeilen haben **0** einen Insider-Leg
(`insiderRaw > 0`) und **0** einen Options-Score. `signalAgeDays` ist genau dann
`null`, wenn es weder einen wertbaren Insider-Trade noch Optionsfluss zum Datieren
gibt — das sind exakt die inhaltsleeren Zeilen aus §1. Die Freshness multipliziert
dort eine Null.

**Der IC ist unverändert**, in allen drei Horizonten und in beiden Partitionen.
Damit ist ein Vorbehalt gegen die Messung nicht mehr offen, sondern beziffert:
0 von 4.474 Zeilen.

### 9.2 Dabei gefunden: der Breakdown konnte seinen eigenen Score nicht reproduzieren

11 Zeilen je Horizont (alle `VWAV`) bestanden die Rekonstruktion zunächst nicht —
das Residuum lag um exakt den Faktor 0,9000 daneben. Ursache: der
`valuationMultiplier` wird auf den **Komposit** angewandt, war aber **kein Feld in
`ScoreBreakdown`**. Er ging also in `rawScore` ein, ohne irgendwo aufgezeichnet zu
werden.

Zwei Folgen:

1. **„Valuation 0,0 % aktiv" war ein Messartefakt, keine Messung.**
   `getFactorActivity` liest `valuationMultiplier` aus dem Breakdown — ein Feld,
   das nie geschrieben wurde und darum immer den Default 1 lieferte. Der Faktor
   war nicht inaktiv, er war unsichtbar. Aus den Residuen zurückgewonnen: je 11
   Zeilen mit den Werten **0,9 · 1,08 · 1,15** — alle drei nicht-neutralen
   Ausgaben von `getValuationMultiplier`. Anders als bei VIX, dessen 0,0 % eine
   echte Messung an einem tatsächlich persistierten Feld ist, war diese Zahl
   gegenstandslos. §2 und §5 sind entsprechend markiert.
2. **Die gespeicherte Historie war stellenweise nicht reproduzierbar** — genau die
   Eigenschaft, auf der jede spätere Neuauswertung aufbaut.

**Behoben:** `valuationMultiplier` ist jetzt Pflichtfeld in `ScoreBreakdown` und
wird von `scoreTicker` geschrieben (vier weitere Konstruktionsstellen angepasst).
Da `upsidePct` derzeit nirgends gesetzt wird, ist der Wert heute überall 1,0 —
**kein Score ändert sich**, `verify:scoring` und die Golden-Datei bleiben
unverändert. Neue Invariante in `tests/invariants.test.ts`: *der Breakdown muss
seinen eigenen `rawScore` reproduzieren können*, über den gesamten Zufalls-Sweep
und über alle Valuation-Zustände. Genau diese Invariante hätte den Defekt sofort
gefunden. Die Rekonstruktionsquote liegt danach bei **100,0 %**.

### 9.3 Was das für die Beweislage ändert

An den Zahlen nichts — und das ist das Ergebnis. Der IC bleibt, wo er war; der
20-Tage-Befund auf der Gesamtmenge bleibt der einzige, der die Clusterbereinigung
überlebt, und er verschwindet weiterhin, sobald die inhaltsleeren Zeilen
ausgeschlossen werden. Was sich ändert, ist die Belastbarkeit: die Messung misst
nachweislich das laufende Modell, und die gespeicherte Historie ist lückenlos
rekonstruierbar.

Unverändert offen bleibt §8.3: der Datensatz ist EIN Marktregime. Hinzu kommt ein
Punkt, den das Re-Scoring nicht löst — die Clusterbereinigung korrigiert die
Abhängigkeit **nach Ticker**, nicht die **zeitliche** Überlappung. Bei einem
Labelfenster von rund 37 Tagen passen ~1,85 nicht überlappende 20-Tage-Fenster
hinein; für die marktweite Komponente ist das effektive n näher an 2 als an 330.
Ein zweidimensionales Clustering (Ticker × Woche) wäre der nächste ehrliche
Schritt an der Statistik.

---

## 10. Nachtrag (2026-08-23) — H1, Variante C: Abdeckung statt Umskalierung

§4.1 hat drei Varianten vermessen und C empfohlen: die Abdeckung von
`marketCap` erhöhen, statt die Ersatzskala anders zu parametrisieren. Umgesetzt
ist C. **Keine Konstante wurde geändert.**

### 10.1 Die Ursache war nicht, was sie zu sein schien

Die Annahme war „der Abruf scheitert bei 34 % der Ticker". Gemessen:

| | Anzahl |
|---|---:|
| Ticker in `signals` | 689 |
| Zeilen in `ticker_meta` | 449 |
| davon **mit** `market_cap` | 424 (**94,4 %**) |
| Ticker **ohne jede** `ticker_meta`-Zeile | **240** |
| davon mit verdoppeltem Anfangsbuchstaben | **143 (59,6 %)** |

Wo eine Zeile existiert, funktioniert der Abruf zu 94 %. Die Lücke sind Ticker,
die **nie eine Zeile bekommen haben** — und 143 davon sind exakt die
Ticker-Korruption aus §2. **Die Ticker-Reparatur ist damit der größte Teil der
Abdeckungs-Korrektur; sie war schon gebaut, nur nicht als solche erkannt.**

Der Rest ist Budget-Verhungern. Die Anreicherungsphase läuft unter einem harten
60-Sekunden-Budget. Die 240 dauerhaft scheiternden Ticker wurden bei **jedem
Lauf** erneut versucht — bis zu drei Requests pro Ticker, ohne dass ein
Fehlschlag je gespeichert wurde. Das Budget war damit strukturell aufgebraucht,
bevor legitime Ticker an die Reihe kamen. Genau deshalb stagnierte die Abdeckung
bei 449.

Live gegen stockanalysis.com verifiziert:

| Symbol | Status | Ergebnis |
|---|---|---|
| `AALK` (korrupt) | 404 | echter Fehlschlag, ab jetzt negativ gecacht |
| `ALK` (repariert) | 200 | **4,51 Mrd.** — die Reparatur liefert die Kapitalisierung |
| `ABBV` (verhungert) | 200 | **468,22 Mrd.** — war nie kaputt, kam nur nie dran |
| `LLY`, `AAPL` (echt verdoppelt) | 200 | 1,12 Bio. / 4,51 Bio. — die Registry-Prüfung schützt sie korrekt |
| `BRK.B` (Anteilsklasse) | 200 | 1,06 Bio. — die URL-Form stimmt bereits |
| `QQQ`, `SPY`, `FB` | 200 **+ Redirect** | ETF bzw. umbenannt — 200, aber die Seite parst zu nichts |

Stichprobe über die de-doppelten Ticker: **14 von 15** liefern eine echte
Marktkapitalisierung.

### 10.2 Was gebaut wurde

1. **Negatives Caching.** Ein definitiver Fehlschlag wird als Zeile ohne Daten
   mit frischem `fetched_at` festgehalten („wir haben nachgesehen"). Die Regel
   steckt in `classifyStockPageResponse` (`scraper/util.ts`), damit sie ohne Netz
   testbar ist: 404/410 → `missing`; 200 **mit Redirect** → `missing` (ETF,
   Umbenennung); alles andere Nicht-2xx → `transient`, **niemals** gecacht.
   Ein Timeout oder ein 429 darf einen echten Ticker nicht für 24 h stilllegen —
   dieselbe Unterscheidung, die der Track-Record-Cache schon dokumentiert.
2. **Rangfolge.** Die Anreicherung arbeitet die Aggregate jetzt nach Bedeutung ab
   (Insider-Volumen bzw. größte Optionsprämie). `prewarmTrackRecords` und der
   Finviz-Fallback ranken längst; ausgerechnet die Phase, die `marketCap`
   erzeugt, tat es nicht. Läuft das Budget aus, trifft der Schnitt nun die
   unwichtigsten Aggregate statt einer beliebigen Array-Position.
3. **Sichtbarkeit.** Jeder Lauf meldet die Abdeckung (`n/m aggregate(s) have a
   marketCap`) und **warnt, wenn das 60-s-Budget vorher ausläuft**. Vorher endete
   die Phase stumm — die Stagnation bei 449 hätte auffallen müssen und konnte es
   nicht.
4. **Negativ gecachte Ticker überspringen auch den Finviz-Fallback.** Sonst wäre
   dasselbe verschwendete Budget nur in eine andere Phase gewandert.

### 10.3 Bewusst NICHT gebaut

- **Kein ETF-Endpunkt** (`/etf/<ticker>/`). Für QQQ oder SPY gäbe es dort ein
  Fondsvolumen, aber „Insider-Kauf in % der Marktkapitalisierung" ist für einen
  ETF keine sinnvolle Größe — es sind Kongress-Trades ohne Insider. Sie werden
  negativ gecacht und kosten nichts mehr.
- **Kein „leeres Parse-Ergebnis = Fehlschlag".** Das wäre die bequemere Regel und
  die gefährlichste: am Tag einer HTML-Änderung von stockanalysis.com würde sie
  das **gesamte** Universum für eine volle TTL negativ cachen. Deshalb hängt die
  Cachebarkeit am Redirect, einer strukturellen Eigenschaft des Symbols, nicht am
  Parse-Ergebnis.

### 10.4 Rest-Lücke, offen und benannt

Geschlossene Fonds wie `PCF` liefern 200 **ohne** Redirect, haben aber keine
Marktkapitalisierungs-Zeile. Sie werden nach der obigen Regel korrekt nicht
negativ gecacht und daher weiter bei jedem Lauf abgerufen. Das ist eine Handvoll
Ticker und der bewusst gewählte Preis dafür, die gefährliche Regel aus §10.3
nicht zu bauen.

Die tatsächliche Abdeckung nach diesen Änderungen lässt sich erst nach einem
echten Scrape-Lauf beziffern — sie hängt am Netz, nicht am Code. Die neue
Log-Ausgabe macht sie ab dann bei jedem Lauf sichtbar.
