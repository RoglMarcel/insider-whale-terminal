# Verifikation von Version 1.6.7

Abgeschlossen am 4. Oktober 2026. Web und reguläres Windows-Release sind veröffentlicht. Die tatsächliche Installation von 1.6.6 auf 1.6.7, der Start der installierten Version und die manuelle Prüfung über den sichtbaren Softwareupdateknopf wurden auf einem isolierten Windows-2022-Runner erfolgreich geprüft. Vorhandene Änderungen im ursprünglichen Arbeitsverzeichnis und lokale Nutzerdaten wurden bewahrt; die Arbeit erfolgte in separaten Checkouts.

## Geprüfte Anwendung und Veröffentlichung

| Gegenstand | Commit beziehungsweise Adresse |
| --- | --- |
| Ausgelieferte Web-Anwendung | `06813925a94358fdd2cdc37e0fd98c2be7f9cd5f` |
| Unveränderter Desktop-Tag v1.6.7 | `49ac079e55e9aa39a619351081cb8d02f00a7365` |
| Abschließender Installationstest, nur Teständerungen | `4c87da5b72f5961c393bb6773b7b54a49df80a9f` |
| Öffentliche Webversion | https://roglmarcel.github.io/insider-whale-web/ |
| Reguläres Desktop-Release | https://github.com/RoglMarcel/insider-whale-terminal/releases/tag/v1.6.7 |

Die nach dem Release ergänzten Commits betreffen ausschließlich Testablauf und Dokumentation. Sie ändern die veröffentlichten Anwendungspakete nicht. Bestehende Releases wurden nicht überschrieben; es gab keinen Force-Push.

## Änderungen

Die gemeinsame Bewertung berücksichtigt geeignete EV-Modelle, Herkunft und Abhängigkeiten der Eingaben. Qualitätsstufen steigen nicht durch abgeleitete Felder oder hinterlegte Ersatzannahmen. Datierte Branchenvergleiche stehen auch der Desktop-Einzelanalyse zur Verfügung. Einheiten, Währungen, Perioden, Aktienanzahl und erklärte Split-Konflikte werden geprüft. Zentrale Modellfamilien, Szenarien, Sicherheitsmarge, externer Vergleich und Datenqualität bleiben getrennt.

Caches sind begrenzt, laufen ab und erlauben erneute Abrufe nach Fehlern. Alte Snapshots werden kompatibel normalisiert; veraltete Bewertungen erhalten bei neuen Score-Berechnungen neutrales Gewicht. Alte historische Scores werden bewahrt und gegenüber einer neueren Anzeige-Bewertung gekennzeichnet. Alerts nennen Insider-Kaufpreis, Börsenreferenzkurs, Prozentdefinitionen und Datenstand getrennt.

Öffentliche HTML-Abrufe verwenden Scrapling mit begrenzter Parallelität und Cooldowns. SEC-Jahresdaten bieten einen validierten, konsistenten Rückfall. Softwareupdates haben sichtbaren Status, manuelle Prüfung, Fehler und Wiederholung. Portfolio-Einstiege berücksichtigen New Yorker Sommer-/Winterzeit und verkürzte Sitzungen; die GME-Regressionsfälle bleiben erhalten.

Die fachlichen Regeln und verbleibenden Grenzen stehen im [Bewertungsvertrag](valuation-integrity.md).

## Tests und öffentliche Daten

- Vor der Korrektur scheiterten vier gezielte Regressionen: EV-Einstufung, fehlende Wachstumsprognose, veraltetes Bewertungsgewicht und Winter-Handelsschluss.
- Danach bestanden in beiden Projekten jeweils 37 Testdateien mit 613 Tests, einschließlich 18 neuer Integritätsregressionen.
- Renderer- und Hauptprozess-Typechecks, Desktop- und Web-Builds sowie Scoring-Regressionen bestanden.
- UI-Prüfungen bestanden bei 1440, 820, 390 und 320 Pixeln, einschließlich deutscher/englischer Texte sowie leerer Daten und Fehlerzustände.
- Liveprüfung mit tatsächlich ausgeführter gebündelter Scrapling-Laufzeit: AAPL, NVDA, PEP, MCD, GME, JPM und SAP.DE.
- Öffentliche Webprüfung um 18:14:30 UTC: Version 1.6.7, 10.579 Suchverzeichniseinträge und 4.420 Bewertungskurzfassungen. Die sieben Beispiele stimmten jeweils zwischen Kurzfassung, vollständiger Datei und Neuberechnung mit identischen Eingaben/Zeitpunkten überein. SAP.DE wurde in EUR geprüft.
- Öffentliche Oberfläche bei 1440, 390 und 320 Pixeln geprüft, ohne horizontalen Überlauf.
- Ausgelieferter Web-Bundle: `index-YgwyxT-C.js`, SHA-256 `161f475246103e868fe551f6fe63a2d1b1ef847ba56ed95a594cd3a5a5193c7d`.

Nachweise:

- [Web-CI](https://github.com/RoglMarcel/insider-whale-web/actions/runs/37222762323)
- [Web-Deployment](https://github.com/RoglMarcel/insider-whale-web/actions/runs/37222762356)
- [Desktop-Releasebuild](https://github.com/RoglMarcel/insider-whale-terminal/actions/runs/37222766685)
- [Abschließende Desktop-CI](https://github.com/RoglMarcel/insider-whale-terminal/actions/runs/37226111988)
- [Tatsächliche Installation und manuelle UI-Prüfung](https://github.com/RoglMarcel/insider-whale-terminal/actions/runs/37226114229)

Alle genannten Läufe wurden bis zum erfolgreichen Abschluss überwacht. Frühere Versuche des zusätzlichen Installationstests scheiterten an seinem Warteablauf beziehungsweise am Altinstaller auf Windows-2025-Runnern. Der korrigierte Test wartet den tatsächlichen IPC-Downloadzustand ab, löst die Test-Debuggerverbindung und verwendet den produktiven automatischen Installationspfad beim regulären Beenden. Die abschließende manuelle Prüfung erfolgt durch den sichtbaren UI-Knopf nach Intro und Versionshinweisen. Der interaktive Installationsassistent wurde nicht per Bildschirmbedienung durchgeklickt.

## Release-Dateien und tatsächlicher Updatepfad

| Datei | Bytes | SHA-256 |
| --- | ---: | --- |
| insider-whale-terminal-setup-1.6.7.exe | 136284986 | `00f7296d0f832abde737ffbf8727043b0c148d30924f0e2c12f4c391ee1cb95f` |
| insider-whale-terminal-setup-1.6.7.exe.blockmap | 143967 | `1270b4a2ee7c1a21788ccfb437259476f5fcf25a658c510adfa856718500a695` |
| latest.yml | 373 | `e7bd3de5e94c6176131c84b20348fd41251bcba21bf8fe272739e72c61ca385c` |

Downloadlinks, Dateinamen und Manifestversion wurden geprüft. Der SHA-512 des tatsächlich heruntergeladenen Installers stimmt mit latest.yml überein. Die GitHub-SHA-256-Werte stimmen ebenfalls mit den Dateien überein.

Der tatsächlich installierte Updater erkannte 1.6.7 ausgehend von 1.6.6 und verwendete erfolgreich den differentiellen Download anhand beider Blockmaps. Nach bestätigtem Download startete er den echten NSIS-Installer mit `--updated /S` beim Beenden der App. Die installierte Datei und der gestartete Hauptprozess meldeten danach 1.6.7. Der sichtbare manuelle Updateknopf meldete anschließend „Up to date“.

Die installierte Scrapling-Laufzeit lieferte die Gesundheitsantwort `engine=scrapling, version=0.4.15, frozen=true`; ihr dokumentierter Quellhash stimmte mit scripts/scrapling/fetch.py des geprüften Repositorys überein.

## Verbleibende Grenzen

Undatierte HTML-Berichtsstände und nicht bestätigte Split-Stände werden nicht erfunden. Ein einzelner FCF-Proxy gilt nicht als historisch normalisiert. Fehlende Prognosen oder sektorbezogene Spezialdaten begrenzen die Qualitätsstufe, insbesondere bei Finanzunternehmen. SEC-Jahresdaten werden nicht still mit TTM-Daten vermischt.

Finviz war in der Liveprüfung nicht erfolgreich erreichbar. Fair Value Calculator und AlphaSpread lieferten erreichbare externe US-Vergleiche; abweichende Modellmeinungen bleiben sichtbar. Einzelne Quellen können weiterhin blockiert oder unvollständig sein. Scrapling garantiert keine Umgehung von Zugriffssperren. GuruFocus und ValueInvesting sind keine aktiven automatischen Quellen.

Windows-Pakete bleiben unsigniert. Die Updateprüfung validiert die Release-Prüfsumme, liefert aber keine Authenticode-Herausgeberidentität. Der echte Installationsnachweis gilt für den beschriebenen isolierten Windows-2022-Runner.
