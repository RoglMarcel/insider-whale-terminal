# Bewertungsvertrag 1.6.7

`electron/fairValue.ts` ist der zentrale automatische Bewertungsweg. Katalog, Desktop-Einzelanalyse und Alerts verwenden diese Funktion. `src/lib/valuationPeers.ts` bildet dieselben Branchen-Mediane aus mindestens fünf anderen Unternehmen derselben Branche/Währung und höchstens 24 Stunden alten Beobachtungen. Die Herkunft nennt Ticker und Originalzeitpunkte. Desktop lädt den veröffentlichten Datenbestand mit TTL und Fehler-Cooldown; im Installer liegen zusätzliche datierte Snapshots für Ausfälle. Katalogläufe verwenden ihren eigenen Bestand. Ohne aktuelle Vergleiche bleibt die Einzelbewertung verfügbar und benennt die Lücke.

Das gespeicherte Format bleibt Version 3; `methodology: 4` bezeichnet die korrigierten Regeln. Alte vollständige Snapshots werden mit ihrem Originalzeitpunkt neu berechnet. Alte Kurzfassungen ohne Eingaben werden nur als ungeprüfte Stufe-1-Fallbacks angezeigt und erhalten kein Score-Gewicht. Nach 24 Stunden sind Bewertungsgewicht und Faktor bei erneuter Berechnung neutral. Bestehende historische Scores werden nicht umgeschrieben; die Oberfläche nennt deren Bewertungsstand und Faktor bei älteren oder anders berechneten Anzeige-Werten.

## Qualitätsstufen

- Stufe 1: einfache Bewertung, fehlende Wachstumsprognose oder wesentliche Ersatzannahmen.
- Stufe 2: mindestens zwei geeignete relative Verfahren, einschließlich EV/EBIT und EV/EBITDA, oder Cashflow mit vorhandener Wachstumsprognose und begrenzter Datenbasis.
- Stufe 3: berechenbarer Cashflow mit ausdrücklich belegten, datierten und konsistenten Cashflow-, Diskont- und Wachstumsdaten. Bloß hinterlegte Quellen, Annahmen, Flag-Felder und ein einzelner FCF-Proxy genügen nicht.

`qualityReasons` und `missingQualityInputs` erklären die Einstufung. Jedes der 26 Modelle nennt seinen Status und konkrete fehlende Eingaben. Banken/Versicherer erhalten keine industriellen DCF-/EV-Verfahren. Ein positiver aktueller FCF ist keine historische Normalisierung. Alte `normalizedFcfePerShare`-Felder bleiben lesbar, werden aber ausdrücklich als Proxy behandelt.

## Daten und Mathematik

Neue Angaben: Quelle, Abrufzeit, tatsächlicher Berichtsstand (oder ausdrücklich unbekannt), TTM/FY/Prognose/Spot, Währung, Einheit, Ursprung, Originalwert, Ableitung und Abhängigkeiten. Einheiten, deklarierte Währungen, Perioden und Split-Konflikte werden vor der Bewertung geprüft. Undatierte HTML-Statistiken können keine Stufe 3 tragen. Der SEC-Parser verarbeitet absolute XBRL-Einheiten aus demselben Jahreszeitraum und derselben Meldungsnummer; Jahreswerte sind ein Rückfall, keine Mischung mit TTM. Nicht bestätigte Split-/Berichtsstände bleiben eine Grenze.

FCFE wird mit Eigenkapitalkosten abgezinst, ohne erneute Cash-Addition. FCFF nutzt WACC und die Cash-/Debt-Brücke je Aktie. Die zentrale DCF-Projektion flacht Wachstum nach drei Jahren über sieben Jahre ab. Terminal- und Diskontannahmen bleiben explizit. Jede abhängige Modellfamilie erhält höchstens eine zentrale Stimme: bei DCF sind Cashflow und unabhängige Gewinnvergleiche bestimmend, andere Verfahren Gegenprüfungen. Sonst bestimmen Ausschüttungs-, Gewinn-, Unternehmens-, Buchwert- und Spezialfamilien den Median. Die Sicherheitsmarge wird einmal auf den zentralen Wert angewandt. Die Szenarien werden separat gezeigt und bleiben breit.

Kursabweichung: `(Kurs / FairValue - 1) * 100`. Potenzial: `(FairValue / Kurs - 1) * 100`. Der Wunschpreis ist eine Kaufbedingung mit Sicherheitsmarge, keine Kursprognose. Der zusätzliche manuelle Szenariorechner behält veränderbare, konstante Wachstumsannahmen und seine ausführliche Modellübersicht; er ist separat beschriftet und ersetzt den zentralen automatischen Wert nicht.

Öffentliche HTML-Abrufe laufen über Scrapling im Runner und im gebündelten Desktop, mit begrenzter Parallelität, TTL, Wiederholung transienter HTTP-Fehler und 15 Minuten Cooldown nach 403/429. Strukturierte SEC- und Kurs-APIs werden direkt gelesen. GuruFocus und ValueInvesting sind keine aktiven automatischen Quellen. Fair Value Calculator und AlphaSpread bleiben getrennt benannte externe Vergleiche. Erreichbarkeit garantiert keine vollständigen Daten und Scrapling garantiert keine Umgehung von Sperren.

## Handel und Updates

Portfolio-Eintritt richtet sich nach `America/New_York`: regulär 16 Uhr, verkürzt 13 Uhr am Tag nach Thanksgiving sowie geeigneten Weihnachts-/Juli-Vortagen. Die tatsächliche verfügbare Preisserie entscheidet über Feiertage und nächste Sitzungen. Zonenlose SQLite-Zeitstempel werden als UTC gelesen, explizite Offsets bleiben erhalten. Historische GME-Fixtures prüfen weiterhin Ausführungskurse und Cash-Regeln.

Softwareupdates sind getrennt von Finanzdaten: Startprüfung, Vierstundenprüfung, manuelle Prüfung, Fehlerzustand/Wiederholung, Downloadfortschritt und Installation nur nach fertigem Download. Der Installer enthält eine anhand des Scraper-Quellhashs und Gesundheitsabfrage geprüfte Scrapling-Laufzeit. `latest.yml` muss Version, Dateiname und SHA-512 des EXE-Pakets enthalten. Reguläre Releases werden aus einem neuen Versions-Tag gebaut; bestehende Releases werden nicht überschrieben. Die Pakete sind unsigniert; SHA-512 und GitHub-Transport ersetzen keine Authenticode-Herausgeberidentität.

## Quellen und Prüfungen

- SEC API-Vertrag: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- Börsenzeiten: https://www.nyse.com/trade/hours-calendars
- Statistik-Parser: https://stockanalysis.com/stocks/aapl/statistics/
- Regressionen: `tests/valuation-integrity.test.ts`, bestehende Bewertungs-, Quellen-, Portfolio-, GME- und UI-Suites; Typechecks für Renderer und Hauptprozess; beide Produktionsbuilds.
- Liveprüfung: `scripts/verify-valuation-live.ts`, AAPL, NVDA, PEP, MCD, GME, JPM und SAP.DE. Livewerte werden auf Gültigkeit und Prozentdefinition geprüft, nicht an einen gewünschten Anbieterpreis angepasst.
