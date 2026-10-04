# Reproduzierbarer Untersuchungsplan – Hypothesen, keine kalibrierte Strategie

Stand 27.09.2026. Die vorhandenen Daten reichen für eine belastbare Rekalibrierung des vollständigen Terminals nicht aus. Keine produktiven Gewichte oder Portfolio-Regeln ändern sich durch diesen Plan.

## Geprüfte Datenlage

Die gesicherte Projekt-DB enthält 29.434 Signalzeilen (15.08.–11.09.2026), die Desktop-DB 6.330 (16.08.–26.09.2026). Das sind wiederholte Beobachtungen, keine ebenso vielen unabhängigen Trades. In 2.200 bzw. 3.214 alten Trade-Payloads sind explizite Transaktions-ID, Revisionslink, Revisionszeit und Beobachtungszeit jeweils nullmal vorhanden. Signal-`scraped_at` kann das erstmalige Beobachten eines Signals belegen, aber weder rückwirkend eine konkrete Transaktionsrevision noch den öffentlichen Empfang jeder Enrichment-Eigenschaft. 26 historische Preislücken bearbeitet der andere Auftrag; hier werden keine Kurse erfunden oder Fälle still ausgeschlossen.

## Primärquellen und Übertragungsgrenzen

- Cohen, Malloy und Pomorski, *Decoding Inside Information*: Die Autoren trennen routinemäßige von opportunistischen Insidergeschäften; ihre untersuchte opportunistische Strategie erzielt 82 Basispunkte abnormalen monatlichen Ertrag, Routine-Trader ungefähr null. Das stützt eine untersuchbare Segmentierung, nicht die hiesige Default-Klassifikation eines ersten Kaufs, CEO-Gewichte oder eine exakte 6-Tage-Halbwertszeit. [NBER, Originalarbeit](https://www.nber.org/papers/w16454).
- Pan und Poteshman, *The Information of Option Volume for Future Stock Prices*: Ihr Informationssignal beruht auf käuferinitiiertem Volumen zur Neueröffnung aus einem besonderen CBOE-Datensatz. Unsere öffentlichen Volumen-/OI-Tabellen identifizieren diese Größen nicht gleichwertig; weder Callvolumen noch Vol/OI beweisen Opening-Buys. Deshalb keine Übernahme eines Koeffizienten auf Sweep-/OTM-Heuristiken. [Originalarbeit](https://www.nber.org/system/files/working_papers/w10925/w10925.pdf).
- Eggers und Hainmueller, *Capitol Losses*: Ihre Portfolio-Rekonstruktion 2004–2008 findet keine generelle Überrendite; durchschnittliche Mitglieder liegen ungefähr 2–3 % jährlich unter dem Markt. Das widerlegt eine universelle Congress-Prämie, entscheidet aber nicht automatisch über jede spätere Teilgruppe oder verspätet kopierte Transaktion. [Autorenfassung](https://www.mit.edu/~jhainm/Paper/Eggmueller_CapitolLosses.pdf).
- Wei und Zhou, *“Captain Gains” on Capitol Hill* (Working Paper 2025): Die Autoren berichten nach Aufstieg in Führungspositionen eine große relative Outperformance gegenüber gematchten Kollegen, vorher nicht. Das ist ein gruppen- und ereignisspezifischer Befund, keine validierte nach Veröffentlichung replizierbare Terminal-Strategie. [NBER-Originaleintrag](https://www.nber.org/papers/w34524). Weder dieser Befund noch der ältere Gegenbefund rechtfertigt einen pauschalen Bonus.

Die Primärquellen wurden erneut recherchiert. Zwei NBER-Landingpages lieferten beim direkten Öffnen 403; Angaben dazu beruhen auf den indexierten Originaleinträgen/PDFs, nicht einer erfundenen vollständigen Replikation. Originalrechnungen wurden nicht mit ihren Rohdaten neu repliziert.

## Festzuschreibender Datenvertrag

Eine Ereigniszeile benötigt `source`, `source_event_id`, `revision_of`, `source_published_at_utc`, `first_observed_at_utc`, unveränderlichen `payload_sha256`, `trade_calendar_date`, `available_at_utc`, Instrumenttyp, Tickerhistorie, Personenkennung/Rolle und die zu diesem Zeitpunkt bekannten Features. Optionsereignisse zusätzlich tatsächliche Eventzeit oder explizit unbekannt, Abrufzeit, Ablaufdatum und belegte Prämienart. Preiszeilen benötigen Handelssitzung, adjustierten Preis, Anpassungsart, Herkunft und Beobachtungszeit.

`available_at = max(belegter Veröffentlichung, eigener erster Beobachtung)` für den handelbaren Replikationspfad. Fehlende Veröffentlichung nicht durch privaten Tradezeitpunkt ersetzen. Nur Beobachtung vorhanden: als Beobachtungsstrategie getrennt ausweisen. Nur Kalenderdatum vorhanden: frühestens folgende verfügbare Sitzung als konservative Datumsauflösung; keine Behauptung exakter intraday-Handelbarkeit. Neue Revisionen ersetzen alte Werte erst ab ihrer eigenen Verfügbarkeit. Später bekannte Marktkapitalisierung, Earnings-Revisionen und Insiderhistorien dürfen nicht rückwärts in Features gelangen.

## Ablauf, der vor Ergebnisansicht festgelegt wird

1. Daten-Snapshot, Quellcode-Commit, Datenvertrag und Kandidatenkonfigurationen mit SHA-256 einfrieren. Modellversion je Signal mitführen. Ein- und Ausschlussgründe als eigene Tabelle speichern; Rohhistorie behalten.
2. Ein Ereignis pro Transaktionsidentität/Version; Wiederabrufe separat. Gleiche Insider/Ticker und überlappende Renditefenster nicht als unabhängige Stichproben zählen. Die Auswahl erfolgt nach erster tatsächlich verfügbarer Beobachtung, niemals nach späterem Tagesmaximum.
3. Kalender nach realen Börsensitzungen. Einstieg nächste handelbare Sitzung nach Verfügbarkeit; fehlt deren Preis, kein fiktiver Einstieg. Renditen nach 5/20/60 Sitzungen getrennt, Total Return mit identischer Benchmarkperiode. Preis-/Delistinglücken samt Quote im Gesamtnenner berichten.
4. Chronologisch sortierte Ereignistage in 60 % Training, 20 % Validierung und 20 % unangetasteten Test teilen; exakte Grenztage im Manifest speichern. Vor jeder Grenze Trainingsfälle entfernen, deren Labelzeit die Grenze berührt; zusätzlich 60 Sitzungen Embargo bei überlappenden maximalen Horizonten. Wenn dadurch kein ausreichender Test übrig bleibt: **kein kalibrierter Parameter**. Mit der jetzigen kurzen Beobachtungsspanne ist gerade das zu erwarten.
5. Train/Validierung wählen ausschließlich vorregistrierte Kandidaten. Baseline: reparierte Datenzulassung bei unveränderten produktiven Gewichten. Gegenmodelle: Insider-only; Baseline ohne einzelne Zusatzkomponente; danach höchstens ein gemeinsam spezifiziertes vereinfachtes Modell. Keine Optimierung auf Testquartilen oder nachträgliches Cherry-Picking einzelner Perioden.
6. Kosten explizit abziehen. Als unkalibrierte Sensitivität 10/25/50 Basispunkte je Kauf und Verkauf, zusätzlich Spread-/Liquiditätskosten aus verfügbarer Instrumenthistorie. Turnover, Slippage, Kapazität und nicht ausführbare Trades berichten. Diese Zahlen sind Szenarien, keine Schätzung tatsächlicher Ausführungskosten.
7. Ergebnisse: Anzahl eindeutiger Ereignisse, Ticker, Insider und Sitzungen; Netto-Mehrertrag, Drawdown, Turnover, Kalibrierungskurve/Quintile; Rang-IC nur bei nichtkonstanten Variablen. Unsicherheit durch Block-Bootstrap nach Zeit und Ticker, Seed `20260927`, 2.000 Wiederholungen. Kandidatenfamilie und alle Versuche offenlegen; Holm-Korrektur über vorregistrierte Primärtests, vollständige unbereinigte/adjustierte Ergebnisse nebeneinander.
8. Primäres Erfolgskriterium vor Auswertung: positives Netto-Mehrertragsintervall im unangetasteten Test und stabile Richtung über Quellen-/Liquiditätssegmente, bei berichteter Abdeckung. Reicht Stichprobe/Intervall nicht, lautet Ergebnis unentschieden. Danach prospektiver Shadow-Lauf mit gesperrten Parametern; keine automatisch ausgelöste produktive Änderung.

## Separat zur Entscheidung vorzubereitende Strategiehypothesen

| Hypothese | Erforderlicher Vergleich | Produktiv geändert? |
|---|---|---|
| Einfacheres Insider-only-Modell | Gleiche kausalen Eingänge, Kosten, Kapitalbasis und Testtage wie Baseline; bestehendes unabhängiges Testportfolio nicht überschreiben | Nein |
| Schwächerer/kein Combo-Multiplikator | Netto-Mehrertrag und Tierwechsel einschließlich Opportunitätskosten, nicht nur Rank-IC | Nein |
| Alternative Freshness-Kurve | Unveränderte Baseline vs vorregistrierte glatte Kurven; Parameter als Hypothesen, keine aus Literatur „bewiesene“ Halbwertszeit | Nein |
| Weniger Volumen-/Cluster-Schwellen | Monotoniefälle und wirtschaftlicher OOS-Vergleich getrennt; kleiner Zusatzkauf darf nicht durch nachträgliche Sollwerte schöngerechnet werden | Nein |
| Congress/Options nur als Kontext | Inkrementeller Nutzen gegenüber Insider-only nach echten Veröffentlichungslags; Instrument- und Quellenunterschiede separat | Nein |

Ausgabeartefakte des späteren Experiments: `manifest.json`, `events.parquet`, `exclusions.csv`, `folds.csv`, `predictions.csv`, `cost_scenarios.csv`, `metrics.json`, `decision.md`. Bestehende `analyze-score`-/Backtestskripte dürfen erst nach Erfüllung dieses Informationszeitvertrags als Kalibrierungsbeleg verwendet werden. Dieser Plan ist eine überprüfbare Versuchsspezifikation; er behauptet weder bereits erzeugte Ereignisdatensätze noch bereits geschätzte Renditen.
