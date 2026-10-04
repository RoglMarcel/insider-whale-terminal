# MATH — Formel-für-Formel-Audit

Jede Zeile enthält eine ausgeschriebene Rechnung oder ein ausführbares Gegenbeispiel.
Die Rechnungen stammen aus `tmp/q/math.ts`, `math2.ts`, `math3.ts`, `blast.ts`
(gebündelt mit esbuild, unter Node bzw. Electron ausgeführt) — nicht aus Kopfrechnen.

Urteile: **korrekt** · **Kommentar-/Doku-Drift** · **strukturell falsch** ·
**unbelegt** · **willkürlich aber vertretbar**

---

## A. Konstanten und Maxima

| # | Objekt | Ort | Behauptung | Prüfung | Urteil | Fix |
|---|---|---|---|---|---|---|
| M1 | `MAX_SINGLE_OPTION_POINTS` | `types:1160` | `= 113.568` | `26 · 1,6 · 1,5 · 1,4 · 1,3 = 113,568` — Laufzeitwert 113.568 | **korrekt** | — |
| M2 | `MAX_OPTIONS_SCORE_TOTAL` | `types:1165` | Kommentar `// 157.248` | `113,568 · 2 = 227,136`. Laufzeitwert **227.136**. 157,248 = `18 · 4,368 · 2`, also der Wert vor Anhebung der Prämienleiter 18→26 | **Kommentar-Drift** | Kommentar auf 227.136 |
| M3 | `MAX_OPTIONS_SCORE` | `scoring:38` | Kommentar `// 157.248` | identisch zu M2 | **Kommentar-Drift** | Kommentar |
| M4 | `MAX_POSSIBLE_RAW` | `scoring:50-58` | JSDoc „≈ 2662.15"; README „≈ 2126" | `MAX_INSIDER_RAW = 10·20·1,0·3,0·2,34·1,15 = 1614,60`; `MAX_OPTIONS_RAW = 227,136·2 = 454,272`; `(1614,60+454,272)·1,2·1,15 = ` **2855,0434**. Mit dem alten 157,248 ergäbe sich exakt 2662,1525 → JSDoc ist die Vorgängerversion. `verify-scoring.ts` prüft bereits korrekt auf 2855,04 | **Kommentar-/Doku-Drift** | JSDoc + README |
| M5 | `MAX_INSIDER_TIMING_MULT` | `types:1156` | `1,8 · 1,3 = 2,34` | Maximum von `getInsiderTimingMultiplier`: `daysToEarnings ≤ 5 → 1,8`, Finanz-Bonus gilt für `≤ 15`, also `1,8·1,3 = 2,34`. Numerisch bestätigt: `getInsiderTimingMultiplier(0,true) = 2,34` | **korrekt** | — |
| M6 | `SCORE_HALF_SATURATION` | `scoring:74` | Anker: raw 420 → Score 80 | `100·420/(420+105) = 80,000` exakt. Ferner `sat(105)=50`, `sat(26,25)=20`, `sat(157,5)=60` | **korrekt** | — |
| M7 | Reichweite der Sättigung | `scoring` | — | `sat(2855,04) = 96,45`. Selbst das **theoretische Maximum aller Faktoren gleichzeitig** erreicht keine 100. Score 100 ist ausschließlich über `norm·softMult` + Clamp erreichbar | **unbelegt** (nicht dokumentiert) | in README dokumentieren |
| M8 | `MAX_VIX_MULTIPLIER = 1.15` | `scoring:35` | Obergrenze der VIX-Rampe | Hartkodiert, während `getVixMultiplier(vix, cap)` den Cap aus `ScoringConfig.vixCap` bezieht. Eine Shadow-Config mit `vixCap = 1,4` macht `MAX_INSIDER_RAW` falsch | **strukturell falsch** (klein) | `DEFAULT_SCORING_CONFIG.vixCap` verwenden |
| M9 | `computeConfidence` Maximum | `scoring:601` | 0–100 | `15+15+5+10+5+10 = 60`, `+25` (≥3 Quellen), `+15` (EDGAR/OpenInsider) `= 100` ✓. Aber `upsidePct` ist dauerhaft `undefined` (Provider entfernt) → real erreichbar **95**, gemessen | **korrekt, aber irreführend** | Doku |

## B. Einzelfunktionen — Definitionsbereich, Schwellen, Randfälle

| # | Objekt | Prüfung (ausgeschrieben) | Urteil | Fix |
|---|---|---|---|---|
| M10 | `getFreshnessMultiplier` | Halbwertszeit `ln2/0,115 = 6,0274 d` (Kommentar „≈6" ✓). Floor 0,15 erreicht bei `ln(1/0,15)/0,115 = 16,497 d`. Messwerte: `f(null)=0,15 · f(0)=1 · f(0,999)=1 · f(1)=0,8914 · f(2)=0,7945 · f(5)=0,5627 · f(10)=0,3166 · f(16,5)=0,15 · f(100)=0,15` | **korrekt** | — |
| M11 | `getFreshnessMultiplier` bei negativem Alter | `f(-5) = 1,0`. Ein um 400 Tage falsch geparstes Zukunftsdatum liefert `signalAgeDays = -399,2`, `fresh = 1,0`, Score 48,8 statt eines Verwerfens | **strukturell falsch** | Zukunftsdatierte Trades wie undatierte behandeln |
| M12 | Freshness-Floor ≡ unbekanntes Alter | `f(null) = f(≥16,5 d) = 0,15`. Ein Signal ohne Datum ist im Score **ununterscheidbar** von einem 17 Tage alten | **strukturell** (bewusst, aber unbelegt) | siehe MONOTONICITY H3 |
| M13 | `getDollarVolumePoints` — gemischte Operatoren | Absolutzweig: `> 5.000.000 → 20`, danach `>= 1.000.000 → 14`. Messung: `4.999.999→14`, **`5.000.000→14`**, `5.000.001→20`. Alle anderen Sprossen nutzen `>=`. Ein Cent verschiebt 14→20 (+43 %) | **strukturell falsch** (interne Inkonsistenz) | `>` → `>=`; Blast Radius 20 von 10.943 Trades (B3) |
| M14 | `baseOptionPoints` — gemischte Operatoren | `>10M→26`, `>5M→22`, `>2M→18`, `>=1M→14`, `>=500k→9`. Messung: `2.000.000→14`, `2.000.001→18`; `5.000.000→18`, `5.000.001→22`; `10.000.000→22`, `10.000.001→26` | **strukturell falsch** (dieselbe Klasse) | `>` → `>=`; Blast Radius **0** von 1227 Optionen (B4) |
| M15 | `getDollarVolumePoints` — zwei Skalen | Derselbe $5M-CEO-Kauf: ohne `marketCap` → 14 Punkte, raw 140, **Score 57,1 (WATCH)**; mit `marketCap = 2·10¹²` → 1 Punkt, raw 10, **Score 8,7 (LOW)**; mit `5·10⁸` → 20 Punkte, Score 65,6. Faktor 20 auf dem Insider-Leg, allein aus Datenverfügbarkeit | **strukturell falsch** | siehe MONOTONICITY H1 |
| M16 | `getDollarVolumePoints(0)` / negativ | `0 → 1`, `-1.000.000 → 1` (beide Zweige). Für eine reine Options-Aggregation ist `perInsiderValue = 0` → 1 Punkt, aber `rankWeight = 0` neutralisiert das | **korrekt** (unerreichbar) | — |
| M17 | `getClusterMultiplier` | `0→1 · 1→1 · 2→1,5 · 3→2 · 4→3 · 5→3 · 100→3`. Harter Deckel ab 4; Sprung 3→4 ist +50 %, der größte der Leiter | **willkürlich aber vertretbar** | Deckel dokumentieren |
| M18 | `getInsiderTimingMultiplier` | `undefined→1 · -1→1 · 0→1,8 · 5→1,8 · 5,0001→1,5 · 15→1,5 · 16→1,3 · 30→1,3 · 31→1`. Mit Finanz-Insider: `0→2,34 · 15→1,95 · 16→1,3` (Bonus endet bei 15) | **korrekt**; Notiztext „Earnings in 1–5 days" schließt `0` nicht ein | Notiztext |
| M19 | `getOptionsTimingMultiplier` | `≤5→2,0 · ≤15→1,6 · ≤30→1,3 · sonst 1,0`. Steiler als die Insider-Kurve (2,0 vs 1,8) — nirgends begründet | **unbelegt** | siehe FACTORS |
| M20 | `getVixMultiplier` | `≤20→1 · 20,01→1,0001 · 27,5→1,075 · 34,99→1,1499 · ≥35→1,15`. Lineare Rampe, stetig, monoton, an beiden Enden stetig angeschlossen | **korrekt** | — |
| M21 | `getVixMultiplier(NaN)` | `NaN ≤ 20` = false, `NaN ≥ 35` = false → `1 + 0,15·((NaN−20)/15)` = **NaN** | **strukturell falsch** | Endlichkeitsprüfung |
| M22 | `getTrackRecordMultiplier` | `clamp(1+(acc−0,5)·0,65, 0,85, 1,2)`. Obergrenze 1,2 ab `acc = 0,5+0,2/0,65 = 0,80769`; Untergrenze 0,85 ab `acc = 0,5−0,15/0,65 = 0,26923`. `f(0)=0,85`, `f(1)=1,2` | **korrekt** | — |
| M23 | `getTrackRecordMultiplier(NaN)` | `Math.min(1,2, Math.max(0,85, NaN))` = `Math.min(1,2, NaN)` = **NaN** | **strukturell falsch** | Endlichkeitsprüfung |
| M24 | `shrunkAccuracy(w,n,k=3)` | `(w+1,5)/(n+3)`. Messwerte: `(0/0)=0,5 · (1/1)=0,625 · (5/5)=0,8125 · (8/10)=0,73077 · (30/40)=0,73256 · (0/10)=0,11538`. Kommentar behauptet für 30/40 „nahe 0,74" — tatsächlich 0,7326 | **korrekt**, Kommentar leicht daneben | Kommentar |
| M25 | `getValuationMultiplier` | `≥40→1,15 · ≥15→1,08 · ≤−25→0,9 · sonst 1,0`. Flache Lücke `(−25, 15)`; asymmetrisch (max. Strafe −10 %, max. Bonus +15 %). **Dormant**: `upsidePct` wird nirgends mehr gesetzt → immer 1,0. **Nachtrag:** historisch HAT der Faktor gefeuert, er wurde nur nie im Breakdown persistiert (REPORT §9) | **unbelegt** (nicht widerlegt — nie testbar) | instrumentieren, nicht löschen |
| M26 | `getRankWeight` | `"" → 1(other)` · `CEO → 10` · `Pres → 8` · `EVP → 3(vp)` · `Dir → 4` · `10% Owner → 5` · `"Dir, 10%" → 5` · `Founder → 8` · `COB → 6` · `Chairman → 6` · `"CEO, CFO" → 10`. Reihenfolge löst Mehrfachrollen deterministisch zugunsten des höheren Rangs auf | **korrekt** | — |
| M27 | `classifyTransaction` — Code-Fallback | `const code = s.charAt(0)` wird auf **beliebige** Beschreibungsstrings angewandt, nicht nur auf echte 1-Zeichen-Codes. Belegte Fehlklassifikationen: `"Acquisition" → 0 (Stock Award)`, `"Automatic Buy" → 0 (Stock Award)`, `"Cash Purchase" → 0,2 (Derivative Conversion)`, `"Common Stock" → 0,2`, `"Dir" → 0 (Sale)`. Ein Kauf wird stumm zu einem nicht wertenden Ereignis | **strukturell falsch** | Code-Zweig nur bei echter Code-Form; Blast Radius auf realen Daten **0** (B2: nur 4 Strings kommen vor, alle korrekt) |
| M28 | `classifyTransaction` — Unbekannt | `"" → 0 (excluded)`, `"   " → 0`. Kommentar „do NOT assume a buy" | **korrekt** | — |
| M29 | `scoreOneOption` | Kette `base · sweep(1,6) · dte(1,5/1,2/0,8) · otm(1,4/1,1) · volOi(1,3/1,1)`. Verifikationsfall: `2,5M, sweep, dte 14, otm 20, volOi 12` → `18·1,6·1,5·1,4·1,3 = 78,624` ✓. Negatives DTE erhält keinen Kurzläufer-Bonus ✓ | **korrekt** | — |
| M30 | `scoreOptionsDetailed` — Schranke | Behauptung „< 2× best". Beweis: nach absteigender Sortierung gilt `xᵢ ≤ x₀`, also `Σ xᵢ·0,5ⁱ ≤ x₀·Σ0,5ⁱ = 2x₀`. Messung: 10 identische Prints à 26 Punkte → **51,949 < 52** ✓ | **korrekt** | — |
| M31 | `scoreOptionsDetailed` — Mutation | Vermutung im Auftrag: die Sortierung mutiere das Input-Array. **Widerlegt**: `bulls`/`bears` sind lokale Arrays; gemessen `Input-Array mutiert? false` | **korrekt** | — |
| M32 | `getPoliticianScore` — Skala | Pro Trade `amountPoints(≤20) · committee(≤1,5) · freshness(≤1) · cluster(≤2,5) = ≤75`, **ohne** geometrischen Decay über Trades summiert. Messung: 20 Politiker à $750k mit Finanzausschuss → **1500,0**, gegenüber `MAX_INSIDER_RAW = 1614,6`. Praktisch durch `LIMIT 40` in `getPoliticianTradesForTicker` auf ~3000 gedeckelt | **strukturell** (Skalen-Asymmetrie) | siehe FACTORS |
| M33 | `getPoliticianScore` — Live-Gate | Einzel-Print live → `0` ✓; 3 Käufer → Cluster ×2,5 ✓; reiner Verkauf → `Math.max(0, …) = 0` ✓ | **korrekt** | — |
| M34 | `corroborationSoftMult` | `combo → 1,2`, `MEGA → 1,25`, `POL_INSIDER → 1,18`, `POL_OPTIONS → 1,15`; bei Kombination `Math.max` (keine Multiplikation) → keine Doppelzählung ✓ | **korrekt** | — |
| M35 | `daysBetween` | Date-only → lokale Mitternacht (kein UTC-Versatz) ✓. DST-Test: `2026-03-01 → 2026-03-15` (US-Umstellung am 8.3.) ergibt **exakt 14,0** — die lokale `new Date(y,m,d)`-Konstruktion kompensiert die 23-Stunden-Woche. Müll → `null` ✓ | **korrekt** | — |
| M36 | `isLateFiling` | `> 4 Werktage`. Die SEC-Frist für Form 4 ist seit 2003 **2 Werktage**; Feiertage werden nicht berücksichtigt | **willkürlich aber vertretbar** (nur Anzeige) | dokumentieren |

## C. Komposition — Monotonie, Vorzeichen, Reihenfolge

| # | Eigenschaft | Prüfung | Urteil | Fix |
|---|---|---|---|---|
| M37 | Sättigung monoton | `sat(r) = 100r/(r+105)` auf `[0,3000]` in 7er-Schritten: streng monoton steigend ✓; stetig; beschränkt durch 100 | **korrekt** | — |
| M38 | **Nicht-Monotonie in `trackRecordMultiplier`** | Bei negativem `coreCombined` und positivem `politicianScore` dreht sich die Wirkung um. Gegenbeispiel (bärischer $11M-Put + kleiner CEO-Kauf + 3 Politiker-Käufe): `bestAccuracy3m = 0,20 → trackMult 0,85 → raw 171,0 → Score 73,1`; `bestAccuracy3m = 0,85 → trackMult 1,20 → raw 148,7 → **Score 69,2**`. **Ein besserer Insider-Track-Record senkt den Score um 3,9 Punkte.** | **strukturell falsch** | Multiplikator nur auf den nichtnegativen Teil |
| M39 | **Nicht-Monotonie in `valuationMultiplier`** | Gleicher Aufbau: `upsidePct = −30` (überbewertet, ×0,9) → `raw 167,8 → Score 72,6`; `upsidePct = +45` (unterbewertet, ×1,15) → `raw 151,9 → **Score 69,8**` | **strukturell falsch** | wie M38 |
| M40 | Options-Timing verstärkt Bärisches | `optionsRaw = opts.score · optionsTiming`. Bei `opts.score = −113,6`: `daysToEarnings = undefined → raw −109,6`; `= 3 → raw −219,9`. Näher an Earnings ⇒ stärker negativ. Inhaltlich vertretbar, aber nirgends festgehalten | **willkürlich aber vertretbar** | dokumentieren |
| M41 | **Nicht-Monotonie in der Insiderzahl** | `perInsiderValue = totalDollarVolume / allInsiders.size`, `clusterMultiplier` zählt nur die letzten 30 Tage. Gegenbeispiel: 2 frische Käufe à $1M → dvp 14, raw 68,3, **Score 39,4**. Dieselben zwei plus zwei *zusätzliche* echte Käufe (200/210 Tage alt, je $10k) → dvp 10, raw 48,8, **Score 31,7**. Mehr Insiderkäufe ⇒ 7,7 Punkte weniger | **strukturell falsch** | Nenner auf dieselbe 30-Tage-Menge wie der Cluster-Zähler |
| M42 | `Math.max(combined, 0)` vor der Sättigung | Klemmt jedes negative Composite auf exakt 0 → alle bärischen Signale sind ununterscheidbar. Zugleich ist genau dieser Clamp der Grund, weshalb M38/M39 in vielen Fällen unsichtbar bleiben | **willkürlich aber vertretbar** | dokumentieren |
| M43 | Corroboration-Gate | `multApplies = softMult > 1 && normLive ≥ 50`. `norm 49,9 → 49,9`; `norm 50,0 → 60,0`. Monoton steigend, aber **Sprung +20 % an der Schwelle** | **willkürlich aber vertretbar** (bewusst) | ggf. glätten; als Produktfrage markiert |
| M44 | Clamp-Reihenfolge live vs. legacy | live: `clamp(norm·softMult,0,100)`; legacy: `clamp(norm + bonus,0,100)`. Beide klemmen nach dem Bonus — konsistent | **korrekt** | — |
| M45 | **NaN erreicht `finalScore`** | `scoreTicker` mit `vix = NaN`: `getVixMultiplier(NaN) = NaN` → `insiderRaw = NaN` → `norm = NaN` → `clamp(NaN,0,100) = NaN`. Gemessen: `score = NaN`, `Number.isFinite(score) = false`. `getConvictionLevel(NaN)` liefert `'LOW'` (beide Vergleiche false). Gleiches über `bestAccuracy3m = NaN`. Heute nur defensiv relevant (alle Quellen validieren mit `Number.isFinite`), aber die Invariante ist verletzt | **strukturell falsch** | Endlichkeitsprüfung an jedem Multiplikator + Endclamp |
| M46 | `Infinity` im Options-Leg | `notional = Infinity` → `baseOptionPoints = 26`, endlich. Gemessen: `score = 0`, `raw = −41,6`, beides endlich | **korrekt** | — |
| M47 | **`scoreTicker` mutiert seinen Input** | `t.shares/t.price/t.value` werden auf `agg.trades` zurückgeschrieben. Gemessen: `value 0 → 25.000` nach dem Aufruf | **strukturell falsch** | nicht mutieren |
| M48 | **Folge: `scoreTicker` ist nicht idempotent** | `sanitizeTradeAmounts(1, undefined, 5.000.000)` liefert `{shares:1, price:5.000.000, …}` — der Preis überschreitet die eigene Schranke `MAX_SANE_SHARE_PRICE = 1.000.000`, weil die letzte Zeile `if (s>0 && p==null) p = v/s` **nach** der Preisprüfung steht. Der zweite Aufruf mit genau dieser Ausgabe liefert `null`. Über die Input-Mutation: 1. `scoreTicker` → **57,1**, 2. Aufruf auf demselben Objekt → **0**. Der Orchestrator ruft bei aktiver Shadow-Config genau zweimal auf | **strukturell falsch** | Preisprüfung ans Ende; keine Mutation. Blast Radius auf realen Daten **0 von 10.943** (B1) — latent |
| M49 | Doppelzählung Earnings | `daysToEarnings` wirkt **auf beiden Legs** (`insiderTiming` ≤2,34 und `optionsTiming` ≤2,0). Beide Legs werden addiert, nicht multipliziert → keine echte Potenzierung, aber der stärkste gemeinsame Treiber (45 % Varianzbeitrag) | **willkürlich aber vertretbar** | dokumentieren |
| M50 | Doppelzählung Freshness | Insider-Leg (`freshestAge`) und Options-Leg (`optionsAge`) haben getrennte Uhren ✓. `detectCombo` verwendet ein drittes Fenster (14 d) | **korrekt** | — |
| M51 | Doppelzählung Größe/Cluster | `perInsiderValue` teilt bewusst durch die Käuferzahl. Wirkt — aber der Nenner ist die falsche Menge (M41) | **strukturell falsch** | siehe M41 |
| M52 | Doppelzählung Rang/Finanz-Bonus | `getRankWeight('CFO') = 8` **und** `isFinanceInsider('CFO') = true` → zusätzlich ×1,3 vor Earnings. Dieselbe Information wirkt zweimal, einmal additiv im Rang, einmal multiplikativ | **unbelegt** | in FACTORS bewertet |
| M53 | VIX marktweit vs. Tier-Grenzen | `vixMultiplier` verschiebt jeden Insider-Score gleichzeitig. Bei VIX 35 wird aus raw 350 (Score 76,9) raw 402,5 (Score 79,3) — die Tier-Grenze 80 wandert also effektiv mit dem Marktregime | **strukturell** (bewusst) | in FACTORS bewertet |

## D. Statistik (Auswertungspfad)

| # | Objekt | Prüfung | Urteil | Fix |
|---|---|---|---|---|
| M54 | Spearman-Rangbildung | `analyze-score.ts` und `performance.ts` verwenden identische Mittelränge bei Bindungen; `dx>0 && dy>0` verhindert Division durch 0 | **korrekt** | — |
| M55 | `SE ≈ 1/√n` | Gilt für **unabhängige** Beobachtungen unter H₀. Hier verletzt: `getOutcomeCandidates` liefert bis zu einen Kandidaten **pro Ticker und Kalendertag**, und die 10/20-Tage-Fenster überlappen fast vollständig. Der ausgewiesene `t ≈ −3,0` bzw. `−4,5` ist damit deutlich überzeichnet | **strukturell falsch** | effektive Stichprobengröße ausweisen |
| M56 | Multiples Testen | 5 Buckets × 3 Horizonte = 15 gleichzeitige Vergleiche, keine Korrektur, keine Konfidenzintervalle | **strukturell** (unvollständig) | CI + explizite Warnung |
| M57 | Populationsmischung | `getScoreOutcomeRows` mischt echte Signale mit **inhaltsleeren Zeilen** (Score 0). Siehe MONOTONICITY H1 — dies ist die dominierende Ursache des negativen IC | **strukturell falsch** | Auswertung partitionieren |
| M58 | `performance.ts` Selektion | `byTickerDay` behält je Ticker-Tag den **höchsten** Score über alle Läufe dieses Tages (`r.score > prev.score`), nicht den ersten. Optimistischer Schätzer | **strukturell** (klein) | ersten Lauf verwenden |
| M59 | Alpha-Definition | `alpha = (exit/entry − 1) − (spyExit/spyEntry − 1)`, adjustierte Schlusskurse, erster Handelstag ≥ Zieldatum. Arithmetisch statt logarithmisch — bei 5–20 Tagen unkritisch (Abweichung < 0,1 pp bei ±10 %). Kalendertage statt Handelstage, konsistent auf beiden Seiten | **korrekt** | — |
| M60 | Look-ahead | `label-outcomes` nutzt `MIN(id)` je Ticker-Tag = erste Sichtung ✓; `entryDate = max(trade, filing, seen)` ≥ Score-Zeitpunkt ✓ | **korrekt** | — |
| M61 | Modellversions-Drift in den Labels | In den gespeicherten Breakdowns haben 50–63 % `signalAgeDays = null`, gleichzeitig 59–72 % `freshnessMultiplier = 1,0`. Die heutige Regel liefert für `null` den Floor 0,15 (Commit 24eae19, 22.08.2026). **Der gesamte gelabelte Datensatz wurde unter einer anderen Freshness-Regel erzeugt** | **strukturell** (Datenlage) | im Bericht ausweisen |
