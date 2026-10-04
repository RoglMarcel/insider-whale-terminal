# DATAFLOW — Pipeline und jede Transformationsstelle

Jede mit **⚠T** markierte Stelle transformiert, rundet, klemmt oder ersetzt einen
Wert durch einen Default. Das sind die Stellen, an denen Information stillschweigend
entsteht oder verschwindet.

```
                 ┌─────────────────────── 9 Insider-Scraper ───────────────────────┐
                 │ edgar · openinsider · finviz · secform4 · marketbeat            │
                 │ gurufocus · insidermonitor · quiverquant · ceowatcher           │
                 └────────────────────────────┬───────────────────────────────────┘
                                              │  RawInsiderTrade[]
   ┌──────── 4 Options-Scraper ────────┐      │
   │ barchart · optionstrat            │      │
   │ insiderfinance · marketbeatoptions│      │
   └──────────────┬────────────────────┘      │
                  │ OptionsActivity[]         │
                                              │
   ┌──── 3 Side-Pipelines (immer an) ───┐     │
   │ capitoltrades (4 Layer)            │     │
   │ sellside (OpenInsider + Form 144)  │     │
   │ activist (EDGAR 13D/13G Atom)      │     │
   └──────────────┬─────────────────────┘     │
                  │                           │
                  ▼                           ▼
        politician_trades / insider_flow /   upsertInsiderTrades()  ──► insider_trades
        filing_events  (SQLite)                       │                (30-Tage-Fenster)
                  │                                   ▼
                  │                       getRecentInsiderTrades(30)
                  │                                   │
                  │                                   ▼
                  │                            dedupTrades()
                  │                                   │
                  │                                   ▼
                  └──────────────────────►   buildAggregates()  ◄──── mergeOptionsActivity()
                                                      │                (72-h-Fenster)
                                                      ▼
                                             Anreicherung (ticker_meta / stockanalysis /
                                             Finviz-Earnings / Track-Records / VIX)
                                                      │
                                                      ▼
                                              scoreTicker()   ──► Signal[]
                                                      │
                                                      ▼
                                              insertSignals() ──► signals
                                                      │
                     ┌────────────────────────────────┼──────────────────────────┐
                     ▼                                ▼                          ▼
             IPC → Renderer                  label-outcomes.ts            webPublish.ts
             (filterSignals)                 → signal_outcomes            → Repo-DB → CI
                                                      │                          │
                                                      ▼                          ▼
                                             analyze-score.ts            publish-data.ts
                                             (Spearman-IC)               → signals.json
                                                                                 │
                                                                                 ▼
                                                                        webApi (GitHub Pages)
```

## Transformationsstellen im Detail

### A) Scraper → RawInsiderTrade / OptionsActivity

| # | Ort | Transformation | Risiko |
|---|---|---|---|
| A1 ⚠T | `util.ts:parseMoney` | Erste Zahl im String, `k/m/b`-Suffix nur direkt anschließend; Klammern und führendes ASCII-`-` → negativ | Unicode-Minus `−` (U+2212) und En-Dash werden **nicht** als Vorzeichen erkannt; unparsbar → `0`, nicht `undefined` |
| A2 ⚠T | `util.ts:parseDate` | 4 Strategien; Monat+Tag ohne Jahr → aktuelles Jahr, ggf. −1 | Fällt auf `Date.parse` in **lokaler** Zeit zurück; unparsbar → `''` |
| A3 ⚠T | `util.ts:cleanTicker` | Uppercase, alles außer `A-Z0-9.-` weg, auf 12 Zeichen gekürzt | **Keine Form-Validierung** → `-`, `3.MONTHMATURE`, `GLASFUNDS`, `NVDAEARNINGS` passieren |
| A4 ⚠T | `util.ts:sanitizeTradeAmounts` | Repariert oder verwirft shares/price/value; `p = v/s`, `v = s*p` | Verwirft still (`null` → Trade fällt weg); idempotent (geprüft) |
| A5 ⚠T | `insiderMap.ts` | `transactionType = cell(...) \|\| 'P'` | **Default `P` = Open-Market-Buy (Modifier 1.0)**, wenn die Spalte fehlt |
| A6 ⚠T | `insidermonitor.ts:mapTradeType` | Unbekannter Code → `'P - Purchase'` | Gleiche Klasse wie A5 |
| A7 ⚠T | `optionsMap.ts` | Sentiment-Fallbackkette endet in `type === 'put' ? bearish : bullish` | Ein Call ohne Richtungsinformation ist immer bullisch |
| A8 ⚠T | `optionsMap.ts` | `dte` aus Spalte nur wenn Ziffer vorhanden, sonst aus `expiry`; `otmPercent` nativ oder aus strike/underlying; `volOiRatio` Spalte oder `volume/oi` | Leere DTE-Zelle darf nicht `0` werden (korrekt behandelt) |
| A9 ⚠T | `optionsMap.ts` | `notional = volume·last·100`, wenn Prämienspalte fehlt | Zeile mit Volumen aber ohne Prämie behält `notional = 0` → 3 Basispunkte |
| A10 ⚠T | `finviz.ts` | Ticker-Reparatur aus dem Quote-Link, **gekeyed auf exakten Zelltext** | `extractTable().getDeepText` fügt bei `DIV`/`P` `\n` ein, `td.textContent` nicht → Key-Mismatch → verdoppelter Anfangsbuchstabe überlebt |

### B) Persistenz + Fenster

| # | Ort | Transformation | Risiko |
|---|---|---|---|
| B1 ⚠T | `upsertInsiderTrades` | PK `(ticker, insider_key, trade_date, value_cents)`; `value_cents = round(value·100)` | Rundung auf Cent ist der Dedup-Schlüssel |
| B2 | `upsertInsiderTrades` | Verwirft Trades ohne Ticker / ohne Insider-Key / ohne `YYYY-MM-DD` / mit `value ≤ 0` | Korrekt und gewollt |
| B3 ⚠T | `getRecentInsiderTrades(30)` | Fenster auf `trade_date ≥ heute−30 d` | Einmal eingeschleuste Fehlzeilen werden 30 Tage lang wiederholt eingespielt |
| B4 ⚠T | `backfillInsiderTradesFromSignals` | Einmaliger Seed aus `signals.raw_trades` | Trägt **alte, fehlerhafte Zeilen** aus der Signal-Historie in die neue Tabelle |
| B5 ⚠T | `mergeOptionsActivity` | 72-h-Fenster, Key = `ticker\|type\|strike\|expiry\|source`; aktuelle Einträge zuerst → frischer Snapshot gewinnt (korrekt) | **`source` ist Teil des Keys**: derselbe Kontrakt von zwei Quellen bleibt zweimal erhalten und wird in `scoreOptionsDetailed` als „zwei Prints" mit geometrischem Decay gezählt (1,5× statt 1×) |
| B6 ⚠T | `buildAggregates` | `agg.options` auf Top-10 nach `notional` gekürzt | Über 10 Prints hinaus geht Information verloren (bei geometrischem Decay praktisch irrelevant) |
| B7 ⚠T | `buildAggregates` | Filter: `hasInsiderSignal \|\| hasWhaleOptions` | Der **einzige** inhaltliche Gate — Politiker-Aggregate umgehen ihn (B8) |
| B8 ⚠T | `scraper/index.ts` ~Z. 953 | Für **jeden** Ticker mit Congress-Buy in 90 d wird ein Aggregat ohne Trades und ohne Optionen angelegt | Erzeugt Signale mit Score **exakt 0**; 55 % des gelabelten Datensatzes |
| B9 ⚠T | `pruneOldData` | signals/scrape_log 365 d, insider_flow/insider_trades/politician_trades 180 d | Kein Prune für `signal_outcomes` (korrekt — Trainingsdaten) |

### C) Anreicherung

| # | Ort | Transformation | Risiko |
|---|---|---|---|
| C1 ⚠T | `getTickerMeta` (TTL 24 h) | Cache-Hit setzt `marketCap`, `sector`, `stats`, `earningsDate` | **Fehlender `marketCap` verändert den Score um Faktor 20** (siehe MATH #7) |
| C2 ⚠T | `daysUntil` / `fetchStockAnalysisEarnings` | Kalendertage-Countdown, lokale Mitternacht | Countdown wird nie gecacht (korrekt) |
| C3 ⚠T | `lookupBestAccuracy` | Nur Insider mit `totalTrades ≥ 5`; `shrunkAccuracy(wins, n, k=3)`; **Maximum** über die Insider | Max-Auswahl ist ein optimistischer Schätzer (Selektionsbias über mehrere Insider) |
| C4 ⚠T | `getNetInsiderFlow` | **MAX** je Seite über Quellen statt Summe | Bewusst; Anzeige-only |
| C5 ⚠T | `getCachedVix()` | `null`, wenn älter als 2 h → `vixMultiplier = 1.0` | Stiller Ausfall des VIX-Faktors ist nicht sichtbar |

### D) Scoring (`scoreTicker`)

| # | Transformation | Risiko |
|---|---|---|
| D1 ⚠T | `eligible = trades.filter(isScoringEligible).filter(sanitize)` — **schreibt `shares/price/value` in den Input zurück** | Input-Mutation |
| D2 ⚠T | `rankWeight = topWeight \|\| (eligible.length ? 1 : 0)` | 0 bedeutet „kein Insider-Leg", nicht „schlechtester Insider" |
| D3 ⚠T | `typeModifier = Σ(mod·w)/Σw`, `w = max(value, 1)` | Wertgewichtet über **nur** förderfähige Trades |
| D4 ⚠T | `perInsiderValue = totalDollarVolume / max(allInsiders.size, 1)` | Nenner = **alle** Insider, Cluster-Multiplikator zählt nur die **letzten 30 Tage** |
| D5 ⚠T | `getDollarVolumePoints` — zwei Skalen (cap-relativ / absolut) | Sprung 1→5→10→14→20 |
| D6 ⚠T | `freshestAge` = jüngster Trade; `null` → Freshness-Floor 0,15 | Undatierbar ≡ 17 Tage alt |
| D7 ⚠T | `optionsAge` aus `max(scrapedAt)`; wird nur bei leerem Insider-Leg zum Badge-Alter | |
| D8 ⚠T | `opts.score = bull − bear` kann **negativ** sein | Vorzeichenwechsel wandert durch alle folgenden Multiplikatoren |
| D9 ⚠T | `coreCombined = (insiderRaw·fresh + optionsRaw·optFresh) · trackRecord · valuation` | Bei negativem `coreCombined` kehren `trackRecord`/`valuation` ihre Wirkungsrichtung um |
| D10 ⚠T | `+ politicianScore` (additiv, andere Skala) | Keine Dimensionsprüfung |
| D11 ⚠T | `norm = 100·max(c,0)/(max(c,0)+105)` | `max(…,0)` klemmt alle negativen Composites auf exakt 0 |
| D12 ⚠T | `final = clamp(norm·softMult, 0, 100)` nur wenn `norm ≥ 50` | 20-%-Sprung an der Gate-Schwelle |
| D13 ⚠T | `score = round(final·10)/10` | Anzeige-Rundung = gespeicherter Wert |

### E) Auswertung

| # | Ort | Transformation | Risiko |
|---|---|---|---|
| E1 ⚠T | `getOutcomeCandidates` | `MIN(id)` je `(ticker, Kalendertag)`; `entryDate = max(trade, filing, seen)` | Ein Ticker liefert bis zu einen Kandidaten **pro Tag** → stark überlappende Beobachtungen |
| E2 ⚠T | `label-outcomes` | `alpha = (exit/entry − 1) − (spyExit/spyEntry − 1)`, Adjusted Close, erster Kurs ≥ Datum | Arithmetisch, nicht log; Kalendertage, nicht Handelstage |
| E3 ⚠T | `analyze-score` | Spearman mit Tie-Mittelrängen; `SE ≈ 1/√n` | SE gilt nur für **unabhängige** Beobachtungen — hier verletzt (E1) |
| E4 ⚠T | `performance.ts` | `byTickerDay` behält den **höchsten** Score je Ticker-Tag | Selektionsbias über mehrere Läufe desselben Tages |
| E5 ⚠T | `getOutcomeCoverage` | „variiert" = Wert ≠ Neutralwert | Miss­t Messbarkeit, nicht Wirkung |

### F) Ausgabe

| # | Ort | Transformation | Risiko |
|---|---|---|---|
| F1 ⚠T | `getLatestSignals` | `MAX(id)` je Ticker **und** `scraped_at ≥ neuester Lauf − 4 d` | Ein Ticker, der 4 Tage nicht gesehen wurde, verschwindet |
| F2 ⚠T | `filterSignals` | Default-Zeitfenster „Woche" = `Tagesbeginn − 6 d`, nach **Trade-Datum** | Leere UI ist meist ein Filter, kein Datenproblem |
| F3 ⚠T | `ScoreBreakdown.tsx` | Zeigt `rawScore / maxPossibleRaw` neben dem Endscore | Suggeriert eine lineare Normalisierung, die es nicht gibt |
| F4 ⚠T | `ScoreBreakdown.tsx` | Zeigt `+45 / +25 / +20` Politiker-Combo-Bonus | Das sind **Legacy**-Werte; live wirken ×1,25 / ×1,18 / ×1,15 |
| F5 | `publish-data.ts` | `signals.json` = vollständige `getLatestSignals()` inklusive `rawTrades` | Keine Sitzungs-/Cookie-Daten enthalten (geprüft) |
