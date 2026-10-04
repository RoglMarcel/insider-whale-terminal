# FACTORS — Plausibilität Faktor für Faktor

Je Faktor: (1) Was behauptet er zu messen? (2) Misst er das? (3) Ist die Richtung
sachlich richtig? (4) Ist er redundant? (5) Trägt er Varianz? (6) Urteil.

**Varianzbeitrag** = Anteil an `Var(log insiderRaw)` über 6176 Signalzeilen mit
Insider-Leg (multiplikative Kette → additiv in Logs). **Variabilität** = Anteil
der Zeilen, in denen der Faktor ≠ Neutralwert ist (n = 6595 Zeilen mit Inhalt).

| Faktor | Variabilität | Varianzbeitrag |
|---|---:|---:|
| `dollarVolumePoints` | 100,0 % | **60,0 %** |
| `rankWeight` | 93,6 % | 18,3 % |
| `freshnessMultiplier` | 94,4 % | 13,3 % |
| `clusterMultiplier` | 24,8 % | 7,9 % |
| `timingMultiplier` | 4,0 % | 0,7 % |
| `typeModifier` | 6,4 % | 0,0 % |
| `trackRecordMultiplier` | 7,7 % | −0,2 % |
| `vixMultiplier` | **0,0 %** | 0,0 % |
| `optionsScore` | 6,9 % | (eigenes Leg) |
| `politicianScore` | 0,7 % | (additiv) |
| `comboBonus` | **0,0 %** | (additiv) |
| `valuationMultiplier` | **0,0 %** (dormant) | 0,0 % |

Paarweise Korrelationen mit |r| ≥ 0,30 (Pearson, n = 6595):

| r | Paar | Deutung |
|---:|---|---|
| **0,983** | `timingMultiplier` ↔ `optionsTimingMultiplier` | derselbe Input (`daysToEarnings`) auf beiden Legs |
| −0,731 | `typeModifier` ↔ `optionsScore` | Artefakt: reine Options-Signale haben `typeModifier = 0` |
| −0,548 | `typeModifier` ↔ `freshnessMultiplier` | dasselbe Artefakt |
| 0,482 | `rankWeight` ↔ `typeModifier` | dasselbe Artefakt |
| 0,391 | `optionsScore` ↔ `freshnessMultiplier` | dasselbe Artefakt |
| 0,334 | `rankWeight` ↔ `clusterMultiplier` | echt: Ticker mit vielen Käufern haben eher auch einen ranghohen Käufer |

**Wichtig:** Nur zwei dieser Korrelationen sind echte Faktorkorrelationen
(0,983 und 0,334). Die übrigen entstehen dadurch, dass reine Options-Signale
alle Insider-Faktoren auf ihren Nullwert setzen — eine Population, kein Faktor.
Keines der beiden echten Paare wird **miteinander multipliziert** auf demselben
Leg: Earnings-Timing wirkt einmal auf Insider und einmal auf Optionen, und die
beiden Legs werden **addiert**. Es gibt also keinen quadrierten Faktor.

---

## 1. `rankWeight` — Rang des kaufenden Insiders

1. **Behauptung:** Je näher der Käufer an der Unternehmenssteuerung, desto
   informierter der Kauf.
2. **Misst er das?** Ja, über den gescrapten Titelstring. Schwachstelle: der
   Titel ist eine Freitextspalte. `getRankWeight('')` → 1 (`other`), und
   6,4 % der Zeilen haben keinen brauchbaren Titel. Eine fehlende Rolle liest
   sich also als „unwichtiger Insider", nicht als „unbekannt".
3. **Richtung:** Richtig und literaturgestützt (Lakonishok/Lee; Jeng/Metrick/
   Zeckhauser). CEO > CFO > Direktor ist Standard.
4. **Redundant?** r = 0,334 mit `clusterMultiplier`, unkritisch.
   Doppelzählung mit `isFinanceInsider`: ein CFO erhält Gewicht 8 **und**
   löst den Finanz-Bonus ×1,3 aus. Dieselbe Information wirkt zweimal.
5. **Varianz:** 18,3 % — zweitgrößter Treiber.
6. **Urteil: behalten + instrumentieren.** Unbekannte Rolle sollte als
   unbekannt behandelt werden, nicht als niedrigster Rang. Die Doppelzählung
   Rang/Finanz-Bonus im Bericht als offene Frage führen (Produktentscheidung).

## 2. `dollarVolumePoints` — Größe des Kaufs

1. **Behauptung:** Ein großer Kauf relativ zur Unternehmensgröße ist ein
   stärkeres Signal als ein kleiner.
2. **Misst er das?** **Nur zur Hälfte.** Bei bekanntem `marketCap`
   cap-relativ, sonst absolut — zwei verschiedene Größen unter einem Namen.
   Abdeckung 61,5 %. Derselbe $5M-Kauf ergibt 1 oder 14 oder 20 Punkte
   (MATH M15). Ein Faktor, der 60 % der Varianz trägt, misst zu einem
   erheblichen Teil **Datenverfügbarkeit**.
3. **Richtung:** Richtig; cap-relativ ist die sachlich bessere Normierung.
4. **Redundant?** Nein. `perInsiderValue` entkoppelt bewusst von der
   Käuferzahl — der Nenner ist allerdings die falsche Menge (MATH M41).
5. **Varianz:** 60,0 % — der dominierende Faktor.
6. **Urteil: strukturell reparieren.** (a) Nenner an das 30-Tage-Fenster
   angleichen. (b) Vergleichsoperator der obersten Sprosse angleichen.
   (c) Fehlender `marketCap` muss als Datenlücke sichtbar sein, nicht als
   stiller Skalenwechsel.

## 3. `typeModifier` — Transaktionsqualität

1. **Behauptung:** Ein Kauf am offenen Markt ist informativer als ein Grant,
   eine Ausübung oder ein 10b5-1-Plankauf.
2. **Misst er das?** Ja, und die Abstufung (1,0 / 0,5 / 0,4 / 0,2 / 0,1 / 0)
   entspricht der Literatur. **Aber**: der Einzelzeichen-Fallback in
   `classifyTransaction` klassifiziert beliebige Beschreibungsstrings über
   ihren ersten Buchstaben — `"Acquisition"` → 0 (Stock Award),
   `"Automatic Buy"` → 0, `"Cash Purchase"` → 0,2 (MATH M27).
3. **Richtung:** Richtig. 10b5-1-Käufe mit 0,4 zu bewerten ist gut belegt
   (vorab terminiert ⇒ kaum Information).
4. **Redundant?** Nein.
5. **Varianz:** 6,4 % Variabilität, 0,0 % Varianzbeitrag — praktisch immer 1,0,
   weil die Aggregate ohnehin auf förderfähige Käufe gefiltert sind.
6. **Urteil: strukturell reparieren** (Code-Fallback), sonst behalten. Der
   niedrige Varianzbeitrag ist kein Gegenargument: der Faktor wirkt als
   **Filter** (Modifier 0 schließt aus), und Filterwirkung erscheint nicht in
   der Varianz der überlebenden Zeilen.

## 4. `clusterMultiplier` — Zahl der kaufenden Insider

1. **Behauptung:** Mehrere unabhängige Insider, die gleichzeitig kaufen, sind
   stärker als einer.
2. **Misst er das?** Ja, über normalisierte Namen in einem 30-Tage-Fenster.
3. **Richtung:** Richtig; Cluster-Käufe sind einer der robustesten Befunde der
   Insider-Literatur.
4. **Redundant?** Bewusst gegen die Größe entkoppelt (`perInsiderValue`), aber
   der Nenner ist die falsche Menge (MATH M41) — dadurch wird die Entkopplung
   an den Rändern zur Nicht-Monotonie.
5. **Varianz:** 7,9 %.
6. **Urteil: behalten, Nenner reparieren.** Der harte Deckel bei 4 Insidern
   (Sprung 2,0 → 3,0, +50 %) ist die größte Klippe der Leiter; Glättung wäre
   strukturell zulässig, ändert aber Scores flächig — als Vorschlag im Bericht,
   nicht als Default.

## 5. `timingMultiplier` (Insider) — Earnings-Nähe

1. **Behauptung:** Ein Insider, der kurz vor der Zahlenvorlage kauft, weiß
   mehr.
2. **Misst er das?** Fraglich. Genau in diesem Fenster gilt bei den meisten
   Emittenten ein **Blackout-Window**: Insider dürfen dort typischerweise
   *nicht* handeln. Ein Kauf 1–5 Tage vor Earnings ist deshalb häufiger ein
   Datenartefakt (falsches Earnings-Datum, verspätete Meldung eines älteren
   Trades) als ein Informationsvorsprung.
3. **Richtung:** **Sachlich zweifelhaft.** Die Literatur zu Insiderhandel vor
   Earnings findet die Anomalie überwiegend bei *Verkäufen* und bei
   *opportunistischen* Händlern, nicht generisch bei Käufen im Blackout.
4. **Redundant?** r = 0,983 mit `optionsTimingMultiplier` — derselbe Input.
   Da die Legs addiert werden, keine Potenzierung.
5. **Varianz:** 4,0 % Variabilität, 0,7 % Varianzbeitrag im Insider-Leg. Die
   im Auftrag genannten „45 % Earnings-Timing" stammen aus der
   *Messbarkeits*analyse (`getOutcomeCoverage`), nicht aus einer
   Varianzzerlegung — beides wird leicht verwechselt.
6. **Urteil: behalten + instrumentieren, als Shadow-Kandidat vorschlagen.**
   Die Blackout-Hypothese ist testbar (Anteil der 1–5-Tage-Fälle, deren
   `filingDate` weit nach `tradeDate` liegt) und gehört ins Kalibrierungs-Panel.
   Nicht entfernen — das wäre eine Modelländerung ohne Beleg.

## 6. `optionsTimingMultiplier` — Earnings-Nähe (Options-Leg)

1. **Behauptung:** Whale-Flow kurz vor Earnings ist gerichteter.
2. **Misst er das?** Plausibel — Optionsflow *ist* im Gegensatz zu Form 4
   nicht durch Blackouts eingeschränkt.
3. **Richtung:** Richtig. Dass die Kurve **steiler** ist als beim Insider-Leg
   (2,0 vs. 1,8) ist im Code nirgends begründet — die Blackout-Überlegung
   liefert nachträglich ein Argument dafür, ist aber nicht dokumentiert.
4. **Redundant?** siehe 5.
5. **Varianz:** 4,0 % Variabilität.
6. **Urteil: behalten, Begründung dokumentieren.** Zusätzlich beachten:
   der Multiplikator verstärkt auch **bärische** Flows (MATH M40) — inhaltlich
   vertretbar, aber undokumentiert.

## 7. `optionsScore` (`scoreOneOption` + `scoreOptionsDetailed`)

1. **Behauptung:** Ungewöhnlicher Optionsfluss misst spekulative Konviktion.
2. **Misst er das?** Teilweise. Vier der fünf Teilfaktoren sind korreliert:
   Sweeps sind überproportional kurzlaufend, kurzlaufende Kontrakte sind
   häufiger OTM, und OTM-Kontrakte haben höhere Vol/OI. Die Kette
   `sweep · dte · otm · volOi` (bis ×4,368) potenziert damit teilweise dieselbe
   Eigenschaft „aggressiver kurzfristiger Spekulationsauftrag".
   Die vorhandenen Daten reichen für eine Messung dieser Korrelation nicht aus
   (nur 6,9 % der Zeilen haben überhaupt einen Options-Score, und die
   Detailfelder fehlen bei MarketBeat vollständig).
3. **Richtung:** Zwei offene Fragen, beide bewusst offen gelassen:
   - **Kurze DTE = Konviktion oder Lotterieschein?** Die Literatur zu
     0-DTE/kurzlaufenden Optionen deutet eher auf Rauschen; der Faktor ×1,5
     unter 21 Tagen ist unbelegt.
   - **Tief-OTM stärker gewichten?** ×1,4 über 15 % OTM. Tief-OTM-Käufe sind
     billig und damit auch für uninformierte Spekulation attraktiv.
   Zusätzlich: der Sentiment-Fallback macht jeden Call ohne
   Richtungsinformation bullisch (DATAFLOW A7) — verkaufte Calls (bärisch)
   werden dann falsch gezählt.
4. **Redundant?** Innerhalb der Kette ja (siehe 2). Zum Insider-Leg nein.
5. **Varianz:** eigenes Leg; variiert in 6,9 % der Zeilen.
6. **Urteil: behalten + instrumentieren.** Der geometrische Decay und die
   bewiesene 2×-Schranke sind sauber. Die vier Teilmultiplikatoren gehören als
   Shadow-Kandidaten einzeln getestet, sobald genug Options-Signale gelabelt
   sind. Kein Eingriff ohne Daten.

## 8. `freshnessMultiplier`

1. **Behauptung:** Ein alter Kauf ist weniger handelbar als ein frischer.
2. **Misst er das?** Ja — mit einer Ausnahme: unbekanntes Alter wird auf den
   Floor gesetzt und ist damit von „17 Tage alt" ununterscheidbar (MATH M12).
   Umgekehrt bekommt ein **zukunftsdatierter** Trade volle Frische (MATH M11).
3. **Richtung:** Richtig, und der einzige Faktor mit bestätigtem
   Out-of-Sample-Alpha aus dem Backtest vom 03.07.2026 (IC 0,342).
4. **Redundant?** Nein; die beiden Legs haben getrennte Uhren.
5. **Varianz:** 13,3 % — drittgrößter Treiber.
6. **Urteil: behalten, Randfälle reparieren.** Kurve und Floor unverändert
   (sie stammen aus einem echten Backtest); nur die Behandlung von `null` und
   von negativen Altern wird sauber gemacht.

## 9. `vixMultiplier`

1. **Behauptung:** Insider, die in einen Angstmarkt hinein kaufen, sind
   überzeugter.
2. **Misst er das?** Der Mechanismus ist plausibel, aber der Faktor ist
   **marktweit**: er verschiebt an einem VIX-35-Tag *jeden* Score gleichzeitig
   um bis zu 15 % und damit auch jede Tier-Grenze (MATH M53). Er misst also
   Marktzustand, nicht Tickerkonviktion.
3. **Richtung:** Sachlich vertretbar (Contrarian-Insider-Käufe in
   Stressphasen sind dokumentiert), aber die Wirkung gehört sauberer als
   Regime-Kontext denn als Score-Multiplikator.
4. **Redundant?** Nein.
5. **Varianz:** **0,0 %** — VIX lag im gesamten Datenfenster ≤ 20.
6. **Urteil: behalten + sichtbar als inaktiv ausweisen.** **Nicht messbar ≠
   widerlegt.** Der Faktor war in diesem Regime nie aktiv; ihn deshalb zu
   entfernen wäre ein Fehlschluss. Zusätzlich fällt er still auf 1,0 zurück,
   wenn der VIX-Abruf älter als 2 Stunden ist — das muss sichtbar werden.

## 10. `trackRecordMultiplier`

1. **Behauptung:** Insider mit historisch treffsicheren Käufen sind es wieder.
2. **Misst er das?** Der Proxy selbst ist **sauber** — geprüft in
   `insiderHistory.ts`: `accuracy3m = profitable3m / totalTrades`, wobei
   „profitable" heißt: 90-Kalendertage-Rendite auf **adjustierten** Schlusskursen
   **minus** SPY über dasselbe Fenster. Fehlt das Benchmark-Fenster, wird der
   Trade verworfen statt mit Marktrendite 0 gewertet; der Survivorship-Bias
   (delistete Ticker liefern keine Historie) ist im Code dokumentiert und in
   der UI ausgewiesen. Zwei Brüche bleiben:
   - Es wird das **Maximum** über alle Insider eines Tickers genommen
     (`lookupBestAccuracy`) — ein optimistischer Schätzer mit Selektionsbias
     über die Zahl der Insider.
   - Bei negativem Composite kehrt die Wirkung sich um (MATH M38).
3. **Richtung:** Richtig; die Bayes-Schrumpfung (k = 3) und die Mindestzahl
   (5 Trades) sind sauber gebaut und verhindern Zufallstreffer.
4. **Redundant?** Nein.
5. **Varianz:** 7,7 % Variabilität, Varianzbeitrag −0,2 % (praktisch null;
   der Multiplikator liegt in 92 % der Fälle exakt auf 1,0).
6. **Urteil: behalten + instrumentieren + Vorzeichenfehler reparieren.** Das
   Max-über-Insider gehört als Frage in den Bericht, nicht in einen stillen
   Umbau.

## 11. `valuationMultiplier`

1. **Behauptung:** Ein Insiderkauf in einem unterbewerteten Titel ist stärker.
2. **Misst er das?** Aktuell **gar nichts**: beide Fair-Value-Provider wurden
   entfernt, `upsidePct` ist immer `undefined`, der Multiplikator immer 1,0.
3. **Richtung:** Plausibel. Die Asymmetrie (Strafe −10 %, Bonus +15 %) und die
   flache Lücke zwischen −25 % und +15 % sind unbelegt.
4. **Redundant?** Nicht prüfbar.
5. **Varianz:** 0,0 % — dormant.
6. **Urteil: behalten + sichtbar als inaktiv ausweisen.** **Nicht messbar ≠
   widerlegt.** Er ist außerdem eine der zwölf Komponenten, die das
   Backtest-Framework verfolgt; ein Entfernen würde die Formel ändern, nicht
   nur einen Input abschalten. Zusätzlich zieht er über `computeConfidence`
   dauerhaft 5 Punkte ab, die niemand erreichen kann.

## 12. `politicianScore` + Combo-Tiers

1. **Behauptung:** Kongressabgeordnete handeln mit Informationsvorsprung.
2. **Misst er das?** Der Live-Modus ist vernünftig gebaut (Cluster ≥ 2 oder
   Insider-Alignment). Zwei Probleme:
   - Der Score wird **additiv** in derselben Zahl wie `coreCombined` addiert,
     obwohl er auf einer anderen Skala entsteht — 20 Politiker à $750k
     ergeben 1500 Punkte, gegenüber `MAX_INSIDER_RAW = 1614,6` (MATH M32).
     Anders als das Options-Leg hat er **keinen** geometrischen Decay.
   - Für **jeden** Ticker mit einem einzigen Kongress-Kauf entsteht trotzdem
     eine Signalzeile mit Score 0 (MONOTONICITY 0a).
3. **Richtung:** Richtig; die Committee-Multiplikatoren (1,5 / 1,4 / 1,3 / 1,2)
   sind allerdings frei gewählt und nirgends begründet.
4. **Redundant?** Der Combo-Tier und der Politiker-Score greifen auf dieselbe
   Information zu; `corroborationSoftMult` verwendet `Math.max` statt eines
   Produkts und vermeidet die Doppelzählung korrekt.
5. **Varianz:** 0,7 % — praktisch inaktiv.
6. **Urteil: behalten, Skala begrenzen, Zeilen ohne Score-Inhalt aus der
   *Auswertung* nehmen.** Ob solche Zeilen im Dashboard erscheinen sollen, ist
   eine Produktentscheidung → Frage an den Nutzer.

## 13. `comboBonus` / `corroborationSoftMult`

1. **Behauptung:** Zwei unabhängige Signalarten auf demselben Ticker
   bestätigen einander.
2. **Misst er das?** Ja, sauber gebaut (`Math.max` statt Produkt, Gate bei
   WATCH).
3. **Richtung:** Richtig.
4. **Redundant?** Nein.
5. **Varianz:** **0,0 %.** Nur 5 von 10541 Zeilen sind je ein klassischer
   Combo gewesen, und **keine** hat das Gate `norm ≥ 50` erreicht.
6. **Urteil: behalten + sichtbar als inaktiv ausweisen.** Der Faktor ist nicht
   widerlegt — er hat nie ausgelöst. Ob das Gate zu hoch liegt, ist eine
   Produktentscheidung → Frage an den Nutzer.

## 14. `computeConfidence`

1. **Behauptung:** Wie viel weiß das System über dieses Signal?
2. **Misst er das?** Ja, und ausdrücklich *nicht* die Signalqualität. Sauber
   getrennt vom Score.
3. **Richtung:** Richtig.
4. **Redundant?** Nein — bewusst orthogonal. Empirisch aber stark mit dem
   Score korreliert (Mittelwert steigt 45,7 → 76,1 über die Buckets), weil
   angereicherte Ticker auch höher scoren.
5. **Varianz:** 100 % Variabilität.
6. **Urteil: behalten.** Einzige Korrektur: die 5 Punkte für `upsidePct` sind
   unerreichbar → dokumentieren.
