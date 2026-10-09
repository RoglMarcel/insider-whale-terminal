# Backtest 1.7.0

Die neue Seite archiviert ausgeführte Entscheidungen der vorhandenen simulierten Depots (Hauptdepot und Insider Only). Sie verändert weder Scores noch Gewichte oder Handelsregeln. Brokerorders werden im Projekt nicht ausgeführt.

## Kauf und unveränderliche Evidenz

Jeder neu gespeicherte Alert erhält in derselben SQLite-Transaktion ein unveränderliches Entscheidungsdokument. Der reguläre Scraper übergibt dazu das vollständige Bewertungsaggregat: Insider- und Optionsdaten, Politikerdaten, Marktinformationen, Bewertungsinputs, verwendete Standard- und Schattenkonfiguration, Bewertungszeitpunkt, VIX inklusive vorhandenem Zeitstempel sowie zugrunde liegende Insider-Track-Records. Der gesamte Signalzustand inklusive Einzelbewertungen, Notizen, Konfidenz, ruhenden Faktoren und Fair-Value-Daten wird kopiert. Öffentliche Konstanten und die Bewertungslogikversion `1.7.0-scoring-1` sind enthalten. Änderungen an der Bewertungslogik müssen diese Version erhöhen. Die Produktionsgewichte bleiben unverändert.

Beim Schreiben des simulierten Depots entstehen Kaufarchiv, Handelsereignis und gegebenenfalls Abschlussdatensatz **in derselben Transaktion wie die Positionen**. Damit existiert kein erfolgreich gespeicherter neuer Kauf ohne Archiveintrag. Der Alert wird über den konkreten Quellenzeitpunkt des gewählten Signal-Datensatzes verbunden; es wird niemals der heutige Alert eines Tickers verwendet. Das Quellen-Dokument muss vor dem modellierten Schlusskurs-Kauf vorhanden gewesen sein und zum verwendeten Score passen. Andernfalls wird der historische Alert-Snapshot als fehlend ausgewiesen. Ein früherer Kauf wird auch dann nicht nachträglich als original befüllt, wenn später neue Daten verfügbar werden.

Die Kaufkennung enthält eine persistierte Datenbank-/Depotkennung, Depotname, Konfigurationsfingerabdruck, Wertpapier und Einstiegstag. Laufende numerische Positions- und Signal-IDs dienen nur der lokalen Verbindung; die dauerhaften Kennungen funktionieren auch beim Desktop-Import mit neu vergebenen Signal-IDs. Zwei unabhängige Depotinstanzen werden nicht zusammengeführt. Wiederholte Läufe fügen keine zweiten Käufe oder Abschlüsse ein. Konfigurationswechsel kennzeichnen eine andere simulierte Strategie. Archive überleben Reset, Neukalkulation, Quellenbereinigung und Neustart.

Auch die Kandidaten des Hauptdepots werden jetzt wie beim zweiten Depot mit ihren zuerst beobachteten Werten behalten. Dadurch verschwinden länger gehaltene Positionen nicht bei einem späteren Simulationslauf aus dem Depot, nur weil die rollierende Alert-Quelle inzwischen bereinigt wurde. Ein- und Ausstiegsregeln bleiben dieselben.

SQLite-Trigger verhindern Änderung und Löschung der originalen Quellen-Dokumente, Kaufdaten, Handelsdaten, Abschlüsse und Analyseversionen. Neue Simulationsergebnisse können abweichen; solche Abweichungen werden separat gespeichert und angezeigt, ohne das Original umzuschreiben. Die Backtest-Liste ist deshalb ein Archiv ausgeführter, beobachteter Entscheidungen, keine stets neu berechnete Variante der aktuellen Depotliste.

## Analyse

Nach dem Commit werden geschlossene Positionen mit ausstehender Analyse automatisch ausgewertet. Dasselbe geschieht beim Start nach einer Unterbrechung. Jede Auswertung erhält eine eigene Kennung, Zeitstempel, Analyseversion und eine vollständige Kopie der verwendeten Daten. Fehler sind eigene, sichtbare Analyseversionen; sie rollen keinen Kauf oder Verkauf zurück. Die Oberfläche bietet erneute Auswertung und Auswahl früherer Versionen.

Die deterministische Analyse beschreibt Haltedauer, absolutes Ergebnis, Rendite, SPY-Vergleich über denselben Zeitraum, damaligen Einstiegsscore, Schwelle, Begründungen und verstärkende/dämpfende Faktoren. Sie trennt beobachtete Renditerichtung und Benchmarkvergleich von nicht belegter Prognosequalität. Sie benennt fehlende Daten, niedrige Konfidenz, ruhende Faktoren und Bewertungswarnungen und formuliert Hypothesen für die spätere Gesamtstichprobe. Sie behauptet keine Nachrichten-, Branchen- oder sonstigen kausalen Zusammenhänge.

## Oberfläche, Export und Synchronisierung

Backtest liegt links unten in der Sidebar und ist auch in der mobilen Navigation verfügbar. Filter umfassen Depotinstanz, Status, Original-/fehlenden Snapshot, Wertpapier und Kaufzeitraum; Sortierungen umfassen Kauf, Verkauf, Score, Rendite und Wertpapier. Geschlossene Positionen sind die Standardansicht. Offene Positionen haben den Status „Auswertung nach Schließung“. Details enthalten Originaldaten bzw. ausdrücklich als historisch fehlend gekennzeichnete Daten, Handelsverlauf, Analysen, verwendete Daten und spätere Replay-Abweichungen.

Der JSON-Export enthält alle Depotinstanzen, Snapshots, Handelsdaten, Abschlussdaten, Einzelbewertungen und sämtliche Analyseversionen unabhängig von den Ansichtsfiltern. `null` bedeutet unbekannt, nicht null Euro. Die gleichen Datensätze werden in `backtest.json` veröffentlicht. Der bestehende Desktop-Transport übernimmt alle Backtest-Tabellen idempotent; die dauerhaften Cloud-Snapshots enthalten sie ebenfalls. Desktop-Publishing wartet nach einem Scrape auf den Depot-Sync, damit dessen neue Käufe und Analysen mitgeliefert werden. Die bestehende Prüfung des zugelassenen Hauptfensters schützt die neuen IPC-Methoden; externe Webseiten erhalten keine Schreibrechte.

Die gehostete Website hat weiterhin keinen serverseitigen Schreibzugang. Dort angeforderte neue Analyseversionen werden dauerhaft **lokal im Browser** gespeichert und exportiert. Dies ist sichtbar beschriftet. Sie werden nicht zur Cloud oder auf andere Geräte synchronisiert. Bei defektem oder gesperrtem Browserspeicher bleiben veröffentlichte Originaldaten lesbar, und der Fehler wird angezeigt. Die zentralen Analysen werden vom gemeinsamen Depotprozess erzeugt und auf beiden Plattformen gelesen.

## Grenzen des vorhandenen Modells

- Es gibt einen Kauf und einen vollständigen Verkauf je Position. Kein Aufstocken und keine Teilverkäufe; erneute Käufe nach Schließung sind eigenständige Positionen gemäß bestehenden Regeln. Eine neue Handelslogik wurde nicht eingeführt.
- Ausführungstag und Schlusskurs sind modelliert, kein tatsächlicher Brokerzeitpunkt. Slippage ist enthalten und separat dokumentiert. Separate Gebühren sind nicht erfasst.
- Das Depot rechnet in USD. Historische EUR-Wechselkurse fehlen. Daher ist das Euroergebnis explizit unbekannt; keine Umrechnung mit einem heutigen Kurs.
- Historische Original-Snapshots können nicht rückwirkend hergestellt werden. Gespeicherte Einstiegsscores bleiben nutzbar, aktuelle Einzelbewertungen werden nicht ergänzt.
- Nachrichtenverlauf, Branchenbenchmark und Intraday-Ausführungen fehlen. Entsprechende Erklärungen bleiben nicht beurteilbar. Eine einzelne Position beweist keine falsche Gewichtung.
- Unveränderliche Evidenz wächst mit den Daten. Ein Archiveintrag wird nicht durch die rollierende Quellenbereinigung gelöscht.

## Prüfungen

`npm run verify:backtest` prüft mit einer isolierten SQLite-Datenbank atomare Käufe, vollständige Inputs, unveränderliche Snapshots nach Quellenänderung, Duplikatfreiheit, Abschlusszuordnung, Benchmark/Ergebnis, versionierte Wiederholung, Replay-Abweichungen, mehrere Depots, Wiederkauf, fehlende historische Daten, Analysefehler, Reset und Neustart.

Der zweite Teil dieses Befehls führt den echten gemeinsamen Depot-Sync mit vollständig zwischengespeicherten Testkursen aus. Beide Depots kaufen, die Alert-Quelldaten werden entfernt, beide Positionen bleiben erhalten und werden bei späteren Kursen geschlossen und analysiert. Wiederholung und Neustart verändern die Archive nicht. Der Test benötigt keine Netzwerkanfragen.

`tests/backtest.test.ts` prüft die Analyse, fehlende Daten und lokale Browser-Versionen einschließlich beschädigtem Speicher. Die vorhandenen Depotregeltests prüfen die Handelsmechanik. Die Python-Persistenztests prüfen Desktop-Merge, Originalerhalt, Versionshistorie und Cloud-Snapshot-Roundtrip. `tests/ui/backtest-ui.cjs` prüft beide Produktionsrenderer mit isolierten Daten bei 390 und 1280 Pixeln: Navigation, Filter, Details, Originaldaten, Wiederholung, Versionsauswahl, Export, Browser-Neuladen und Layout. Für den Desktop-Renderer wird die sichere API-Brücke durch eine isolierte Test-API ersetzt; es wird keine produktive Datenbank geöffnet.

Die CI führt diese Prüfungen zusätzlich zu Typprüfung, bestehenden Unit-Tests und beiden Produktionsbuilds aus. Es wurde nichts auf die Live-Website veröffentlicht und keine produktive Depotdatei für Tests verändert.

Prüfstand 9. Oktober 2026: Typprüfung für beide Projekte, 598 Unit-Tests, 20 Python-Persistenztests, vier bestehende SQLite-/Desktop-Transport-Integrationstests, beide Backtest-Integrationsprüfungen sowie Web- und Desktop-Produktionsbuild bestanden. Die Backtest-Bedienungsprüfung besteht für beide Renderer bei 390 und 1280 Pixeln; die bestehende gesamte Web-Oberflächenprüfung besteht bei 320, 390, 820 und 1440 Pixeln einschließlich leerer und fehlgeschlagener Datenzustände. Ein Installationspaket und ein Live-Deployment wurden nicht erzeugt.
