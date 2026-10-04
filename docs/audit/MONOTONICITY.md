# MONOTONICITY — warum der Score nicht monoton aussieht

Ausgangsbefund des Auftrags: „Der Score ist über alles gerechnet invertiert —
IC(10d) ≈ −0,079 (t ≈ −3,0), IC(20d) ≈ −0,149 (t ≈ −4,5)."

Dieses Dokument prüft mechanistische Hypothesen gegen Code **und** Daten.
Alle Zahlen stammen aus `tmp/q/mono.js` / `mono2.js` gegen `data/insider-tracker.db`.

---

## 0. Das Wichtigste zuerst: zwei unabhängige Messfehler

Bevor irgendeine Modellhypothese nötig wird, halten zwei Eigenschaften der
Messung dem Ergebnis nicht stand.

### (a) Der Datensatz mischt zwei Populationen

`getOutcomeCandidates()` labelt **jede** Signalzeile. 55 % der 10-Tage-Zeilen
(794 von 1442) haben `rankWeight == 0` **und** `optionsScore == 0` — sie
enthalten keinerlei Score-Inhalt. Ihr Score ist per Konstruktion 0–2,4.

Herkunft (Code-Beleg, `electron/scraper/index.ts` ≈ Z. 953):

```ts
for (const ticker of getPoliticianTradeTickers(90)) {
  if (existing.has(ticker)) continue;
  const pts = getPoliticianTradesForTicker(ticker, 90);
  if (!pts.some((t) => t.transactionType === 'buy')) continue;
  aggregates.push({ ticker, trades: [], options: [], politicianTrades: pts, sourceUrls: [] });
}
```

Für **jeden** Ticker mit einem einzigen Kongress-Kauf in 90 Tagen entsteht ein
Aggregat. `getPoliticianScore` im Live-Modus gibt für Einzel-Prints jedoch 0
zurück. Ergebnis: eine Signalzeile mit Score 0, die persistiert und gelabelt wird.

Diese Zeilen sind ein **anderes Universum**: 53 % gehören zu `BIG_PLAYERS`
(HD, ABBV, ADBE, AMZN, ASML, AVGO …), gegenüber 11 % bei den echten Signalen.
Über die gesamte Signaltabelle sind es 3946 von 10541 Zeilen (37,4 %).

### (b) Die Beobachtungen sind stark geclustert, das ausgewiesene SE ignoriert das

`SE ≈ 1/√n` gilt nur für unabhängige Beobachtungen. Gemessene
Intra-Cluster-Korrelation nach Ticker: **ρ = 0,45 (10 d)** bzw. **ρ = 0,77 (20 d)**,
im Mittel 4,1 bzw. 3,3 Beobachtungen je Ticker.

### Beides zusammen — die Zerlegung

| Horizont | Menge | n | n_eff | IC | t (naiv) | **t (clusterbereinigt)** | 95 %-KI |
|---|---|---:|---:|---:|---:|---:|---|
| 5 d | ALLE | 2115 | 1305 | 0,003 | 0,16 | 0,12 | [−0,051; 0,058] |
| 5 d | **mit Inhalt** | 1029 | 816 | 0,028 | 0,89 | 0,79 | [−0,041; 0,096] |
| 5 d | inhaltsleer | 1086 | 647 | −0,009 | −0,30 | −0,23 | [−0,086; 0,068] |
| 10 d | ALLE | 1442 | 606 | −0,079 | −3,00 | **−1,95** | [−0,158; **0,001**] |
| 10 d | **mit Inhalt** | 648 | 344 | −0,039 | −1,00 | **−0,73** | [−0,145; 0,067] |
| 10 d | inhaltsleer | 794 | 303 | −0,008 | −0,22 | −0,13 | [−0,120; 0,105] |
| 20 d | ALLE | 917 | 330 | −0,149 | −4,51 | **−2,70** | [−0,253; −0,042] |
| 20 d | **mit Inhalt** | 437 | 190 | −0,015 | −0,31 | **−0,20** | [−0,157; 0,128] |
| 20 d | inhaltsleer | 480 | 170 | 0,032 | 0,69 | 0,41 | [−0,119; 0,181] |

**Lesart.** Der 10-Tage-Befund ist nach Clusterbereinigung **nicht mehr
signifikant** (|t| = 1,95 < 2; das KI enthält die Null). Der 20-Tage-Befund
überlebt die Clusterbereinigung auf der Gesamtmenge (t = −2,70), **verschwindet
aber vollständig**, sobald die inhaltsleeren Zeilen ausgeschlossen werden
(IC = −0,015, t = −0,20).

Der negative IC ist damit überwiegend ein **Zwischen-Populations-Effekt**
(Simpson-Paradoxon), kein Beleg für eine invertierte Rangordnung innerhalb
echter Signale. Was übrig bleibt, ist schwächer, aber ehrlicher:

> Innerhalb echter Signale rankt der Score **nicht** — IC ist von Null nicht
> unterscheidbar. Und das Insider-Universum lag in diesem Regime über 20 Tage
> ~1,7 % hinter SPY.

---

## 1. Hypothesen — geprüft

### H1 — `getDollarVolumePoints` bildet zwei verschiedene Größen auf dieselbe Skala ab

**Mechanismus (Code).** Der Zweig hängt an der Datenverfügbarkeit:

```ts
if (marketCap && marketCap > 0) { /* cap-relativ: 0.5% / 0.1% / 0.02% / 0.005% */ }
/* sonst: absolut: >5M / ≥1M / ≥500k / ≥100k */
```

**Rechnung.** Derselbe $5M-CEO-Kauf, gemessen:

| `marketCap` | Punkte | raw | Score | Tier |
|---|---:|---:|---:|---|
| unbekannt | 14 | 140,0 | **57,1** | WATCH |
| 2 · 10¹² | 1 | 10,0 | **8,7** | LOW |
| 1 · 10¹⁰ | 10 | 100,0 | 48,8 | LOW |
| 5 · 10⁸ | 20 | 200,0 | 65,6 | WATCH |

**Gewicht.** `dollarVolumePoints` trägt **60,0 %** der Varianz von
`log(insiderRaw)` — mit Abstand der dominierende Faktor (rankWeight 18,3 %,
freshness 13,3 %, cluster 7,9 %). Die `marketCap`-Abdeckung liegt bei
**61,5 %** (424 von 689 Tickern), d. h. gut ein Drittel aller Signale wird auf
einer anderen Skala bewertet als der Rest.

**Datenprüfung.** IC getrennt nach Abdeckung (nur Zeilen mit Insider-Leg):

| Horizont | cap bekannt | cap unbekannt |
|---|---|---|
| 5 d | IC 0,022 (n=406) | IC 0,081 (n=403) |
| 10 d | IC −0,127 (n=96) | IC 0,041 (n=379) |
| 20 d | IC −0,205 (n=60) | IC −0,000 (n=276) |

**Urteil: bestätigt als struktureller Fehler, als Erklärung teilbestätigt.**
Der Vorzeichenunterschied ist konsistent mit der Hypothese, die
cap-bekannt-Teilstichprobe ist mit n = 60…96 aber zu klein für einen Beweis.
Der strukturelle Fehler selbst — ein Faktor, der 60 % der Varianz trägt und
je nach Datenverfügbarkeit die Einheit wechselt — steht unabhängig von den
Outcome-Daten fest und ist damit nach Regel 4 reparierbar.

---

### H2 — Das Band 20–59 ist eine eigene Signalklasse

**Prüfung (10 d, nur Zeilen mit Score-Inhalt):**

| Band | n | Ø Alpha | SE | t (naiv) | reine Options-Signale | cap bekannt | Ticker |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0–19 | 343 | +1,07 % | 0,56 % | 1,91 | 29 % | 25 % | 170 |
| 20–59 | 287 | **−1,91 %** | 0,71 % | −2,69 | 26 % | 32 % | 127 |
| 60+ | 18 | +6,83 % | 1,69 % | 4,05 | 0 % | 17 % | 13 |

Der Anteil reiner Options-Signale (29 % / 26 % / 0 %) und die
`marketCap`-Abdeckung (25 % / 32 % / 17 %) unterscheiden sich **nicht**
substantiell zwischen 0–19 und 20–59. Eine dominierende Quelle, ein
dominierender Transaktionstyp oder eine dominierende Tickerklasse ließ sich
nicht finden.

**Urteil: nicht bestätigt.** Die Delle bleibt auch nach der Bereinigung
sichtbar (−1,91 %), aber clusterbereinigt (Designeffekt 2,38) liegt
t bei ≈ −1,74 — im Rauschen. Die Bucket-Monotonie ist in allen Varianten
0,50 (von 3 auswertbaren Buckets mit n ≥ 30 steigt genau eins).

---

### H3 — Der Freshness-Floor vermengt „undatiert" mit „wirklich alt"

**Mechanismus (Code, bestätigt).** `getFreshnessMultiplier(null) = 0,15` und
`getFreshnessMultiplier(t ≥ 16,5) = 0,15`. Ein Signal ohne parsbares Datum ist
im Score **ununterscheidbar** von einem 17 Tage alten.

**Datenprüfung.** Von 108 Zeilen auf dem Floor sind **0 undatiert** und 108
wirklich alt.

**Grund:** Die Regel `null → floor` kam erst mit Commit `24eae19`
(22.08.2026), die Labels enden am 16.08.2026. Alle gelabelten Zeilen wurden
noch unter `null → 1,0` erzeugt — nachweisbar daran, dass 50–63 % der
Breakdowns `signalAgeDays = null` **und** gleichzeitig
`freshnessMultiplier = 1,0` tragen.

**Urteil: im Code bestätigt, in den Daten noch nicht beobachtbar.** Die
Vermengung wird erst mit künftigen Labels messbar. Sie wird trotzdem behoben
(Kennzeichnung statt stiller Gleichsetzung), weil sie aus der Logik folgt.

**Nebenbefund von erheblicher Tragweite:** Der gesamte gelabelte Datensatz
wurde unter einer **anderen** Freshness-Regel erzeugt als der heutige Code.
Der gemessene IC beschreibt damit nicht das aktuelle Modell.

---

### H4 — Der Combo-/Korroborations-Pfad verzerrt den oberen Bereich

**Prüfung.** Von 10541 Signalzeilen haben **5** `combo_signal = 1`, und
**keine einzige** davon erreicht das Gate `norm ≥ 50`. `comboBonus` variiert
in **0,0 %** der Zeilen. 65 Zeilen tragen einen Politiker-Combo-Tier.

**Urteil: widerlegt.** Der Korroborationspfad hat in diesem Datensatz nie
gewirkt und kann den IC nicht erklären. Er ist damit auch **nicht widerlegt** —
er war nie testbar.

---

### H5 — Nicht-Monotonie durch Vorzeichenwechsel im Composite

**Mechanismus.** `coreCombined = (insiderRaw·fresh + optionsRaw·optFresh) ·
trackRecord · valuation`. Wird `optionsRaw` stark negativ, kann `coreCombined`
negativ werden; `politicianScore` wird **danach** addiert. Auf einem negativen
Zwischenergebnis kehren `trackRecord` und `valuation` ihre Wirkungsrichtung um.

**Gegenbeispiele (gemessen, `tmp/q/math.ts` M11/M12):**

| `bestAccuracy3m` | trackMult | raw | **Score** |
|---|---:|---:|---:|
| 0,20 (schlechter Track Record) | 0,85 | 171,0 | **73,1** |
| 0,50 (Münzwurf) | 1,00 | 161,4 | 71,5 |
| 0,85 (sehr guter Track Record) | 1,20 | 148,7 | **69,2** |

| `upsidePct` | valMult | raw | **Score** |
|---|---:|---:|---:|
| −30 (überbewertet) | 0,90 | 167,8 | **72,6** |
| — (unbekannt) | 1,00 | 161,4 | 71,5 |
| +45 (unterbewertet) | 1,15 | 151,9 | **69,8** |

**Urteil: bestätigt als struktureller Fehler.** In den vorliegenden Daten
selten wirksam (`trackRecordMultiplier` variiert in 7,7 % der Zeilen,
`politicianScore` in 0,7 %, negative `optionsScore` sind ebenfalls selten),
aber die Formel ist an dieser Stelle nachweisbar falsch.

---

### H6 — Nicht-Monotonie in der Zahl der kaufenden Insider

**Mechanismus.** `perInsiderValue = totalDollarVolume / allInsiders.size`
(alle förderfähigen Insider, **ohne** Altersgrenze), während
`clusterMultiplier` nur Insider der letzten 30 Tage zählt.

**Gegenbeispiel (gemessen):**

| Aggregat | Volumen | insiderCount | cluster | dvp | raw | **Score** |
|---|---|---:|---:|---:|---:|---:|
| 2 frische Käufe à $1M | $2,00M | 2 | 1,5 | 14 | 68,3 | **39,4** |
| dieselben + 2 alte à $10k | $2,02M | 4 | 1,5 | 10 | 48,8 | **31,7** |

Zwei **zusätzliche echte Insiderkäufe** senken den Score um 7,7 Punkte.

**Urteil: bestätigt als struktureller Fehler.**

---

### H7 — Regime-Effekt statt Modellfehler

**Prüfung (zeitlicher Out-of-Sample-Split, Median als Schnitt):**

| Horizont | Schnitt | IS | OOS |
|---|---|---|---|
| 5 d | 2026-07-30 | 0,023 (n=922) | −0,008 (n=1193) |
| 10 d | 2026-07-17 | −0,009 (n=559) | −0,111 (n=883) |
| 20 d | 2026-07-12 | −0,130 (n=368) | −0,166 (n=549) |

Das Vorzeichen ist über den Split stabil. Beide Hälften stammen aber aus
demselben Marktregime (Juli–August 2026) **und** teilen den Populationsfehler
aus Abschnitt 0.

**Urteil: nicht entscheidbar.** Ein zeitlicher Split innerhalb eines Regimes
ist kein Out-of-Sample-Test im relevanten Sinn.

---

### H8 — Größen-/Qualitätsfaktor der Zusatzpopulation

**Prüfung.** Mittleres Alpha nach `BIG_PLAYERS`-Zugehörigkeit:

| Horizont | BIG_PLAYERS | übrige |
|---|---|---|
| 5 d | −0,19 % (n=686) | +0,49 % (n=1429) |
| 10 d | +0,02 % (n=495) | +0,52 % (n=947) |
| 20 d | **+0,91 %** (n=295) | **−0,55 %** (n=622) |

Beim 20-Tage-Horizont — genau dort, wo der negative IC am stärksten ist —
schnitten Mega-Caps besser ab als der Rest. Da 53 % der inhaltsleeren Zeilen
Mega-Caps sind (gegenüber 11 % bei den echten Signalen) und diese Zeilen den
gesamten unteren Score-Bereich besetzen, erzeugt allein diese Zusammensetzung
eine negative Rangkorrelation.

**Urteil: bestätigt als Mechanismus hinter Abschnitt 0(a).**

---

## 2. Verworfene Hypothesen

| Hypothese | Warum verworfen |
|---|---|
| Eine bestimmte Quelle dominiert das Band 20–59 | Quellenverteilung ist über die Bänder homogen; nur 4 verschiedene `transactionType`-Strings existieren überhaupt |
| Ein bestimmter Transaktionstyp | `typeModifier` variiert in nur 6,4 % der Zeilen, Mittelwert 0,936 |
| Der Combo-Bonus hebt schwache Signale über die Schwelle | H4: Gate hat nie geöffnet |
| VIX verschiebt die Tiers im Zeitverlauf | `vixMultiplier` variiert in **0,0 %** der Zeilen (VIX blieb ≤ 20) |
| Valuation verzerrt | `upsidePct` ist seit dem Provider-Ausbau immer `undefined` |
| `scoreOptionsDetailed` mutiert das Input-Array und verfälscht Folgeaufrufe | Gemessen widerlegt (M31); die Arrays sind lokal |
| Look-ahead im Labeling | `MIN(id)` = erste Sichtung; `entryDate = max(trade, filing, seen)` ≥ Score-Zeitpunkt |

---

## 3. Was daraus folgt

1. **Messung reparieren, bevor über das Modell geurteilt wird.** Die
   Kalibrierung muss inhaltsleere Zeilen getrennt ausweisen, die effektive
   Stichprobengröße nennen und Konfidenzintervalle statt nackter SE zeigen.
2. **H1, H5, H6 sind strukturelle Fehler** und werden repariert — die
   Begründung ist in jedem Fall Mathematik/Logik, nicht der IC.
3. **H3 wird repariert**, obwohl sie in den Daten noch nicht sichtbar ist:
   sie folgt aus dem Code.
4. **Kein Faktor wird wegen fehlender Messbarkeit entfernt.** VIX (0 %
   Varianz) und Valuation (dauerhaft neutral) sind nicht widerlegt — sie
   waren nie testbar.
5. Nach den Reparaturen ist der IC **nicht** die Erfolgsmetrik dieses Audits.
   Ein Datensatz aus einem einzigen Regime, mit n_eff ≈ 190–816 und einem
   Modellwechsel mitten in der Historie, kann eine Verbesserung nicht belegen.

---

## Nachtrag — Messung der Reparaturvarianten für H1

Beschlossen wurde: **dokumentieren, nicht ändern**. Die Zahlen, auf deren Basis
später entschieden werden kann (gemessen auf dem aktuellen Signalstand, Uhr
eingefroren, `tmp/q/measure.ts`):

**Variante A — unverändert lassen.** `marketCap`-Abdeckung unter den behaltenen
Signalen: **333 von 505 (65,9 %)**. Ein gutes Drittel wird weiterhin auf der
absoluten Leiter bewertet.

**Variante B — die absolute Leiter an die cap-relative bei 1 Mrd. USD ankern.**
Zwei der vier Sprossen implizieren diesen Anker bereits
(`$5M / 0,005 = $1 Mrd.`, `$1M / 0,001 = $1 Mrd.`), die beiden unteren dagegen
2,5 Mrd. bzw. 2 Mrd. — die Leiter ist also nicht einmal in sich konsistent.
Konsequente Ableitung: `≥$5M → 20, ≥$1M → 14, ≥$200k → 10, ≥$50k → 5`.
Wirkung: **74 Ticker ändern sich, davon 3 mit Tier-Wechsel**; die größten
Verschiebungen liegen bei +14 bis +25 Punkten (alle nach oben, weil die Schwellen
sinken). Begründbar ohne Outcome-Daten (interne Konsistenz zweier Konstanten),
aber flächenwirksam.

**Variante C — Abdeckung erhöhen statt Formel ändern.** **166 bewertete Signale**
ohne Marktkapitalisierung würden auf die cap-relative Leiter wechseln, sobald der
Wert bekannt ist. Ändert keine einzige Konstante und verkleinert das Problem an
der Wurzel, statt die Ersatzskala zu kalibrieren. Kosten: eine zweite
`marketCap`-Quelle oder ein Backfill über `ticker_meta`.

**Einschätzung (Buy-Side-Hut):** Variante C ist die einzige, die den Faktor
*besser misst*, statt die Ersatzmessung anders zu skalieren. B verschiebt Scores
flächig, ohne dass irgendetwas gemessen besser würde. A ist ehrlich, solange die
Lücke dokumentiert ist — was sie jetzt ist (README, Abschnitt „Scoring Model").
