# Testing Portfolio — build report

**Built:** 2026-08-23 · **Version:** 1.4.0 · **Branch:** `claude/testing-portfolio-sp500-674f88`

> **Dated record.** Every `≥ 74` below is the entry threshold *as it stood on
> 2026-08-23*. It is **70** since v1.5.1 — derived from signal supply against the
> book's 20-position capacity rather than by hand; see the README section
> "Why 70". The exit rules changed on the same day this was written; see the
> correction on design decision 4.

A simulated, rule-based $10,000 book that "invests" in the terminal's strongest
signals and is plotted against the S&P 500. The rules, the assumptions and the
commands are in the README under "Testing Portfolio"; this document is the
measurement record and the honest assessment.

**The short version:** over the 31 sessions the stored data can speak for, the
portfolio ended at **$10,239.91 (+2.45%)** against **$10,137.59 (+1.43%)** for
SPY — a lead of **+1.02 percentage points**. That lead is **not statistically
meaningful**. Six closed trades, mean per-trade alpha +3.99%, t = 0.66,
95% CI −7.9% … +15.9%. The single best trade made more money than the entire
lead. Section 4 works through why, and what would have to happen for the number
to mean something.

---

## 1. Phase 0 — the data, measured

Measured read-only against `data/insider-tracker.db` on 2026-08-23. The brief's
figures were re-derived, not assumed; all of them held.

| Fact | Brief | Measured | |
|---|---|---|---|
| `signals` rows | 12,728 | **12,728** | ✓ |
| `signals` range (`scraped_at`) | 2026-08-15 → 08-23 | **2026-08-15 → 08-23 (9 days)** | ✓ |
| `scrape_log` sessions | 43 | **43** | ✓ |
| Highest score ever stored | 76.6 | **76.6** | ✓ |
| Signals with score ≥ 80 | 0 | **0** | ✓ |
| Distinct (ticker, day) with score ≥ 74 | 5 | **5** in 9 days | ✓ |
| `signal_outcomes` rows | 2,119 / 1,442 / 917 | **2,119 / 1,442 / 917** (4,478) | ✓ |
| `signal_outcomes` entry range | 2026-07-10 → 08-16, 11 days | **2026-07-10 → 08-16, 11 distinct days** | ✓ |
| `insider_trades` | 879 | **879**, 2026-04-10 → 08-21 | ✓ |

Score distribution in `signals` (distinct ticker-days):

| Threshold | rows | distinct (ticker, day) | distinct tickers |
|---|---|---|---|
| ≥ 60 | 165 | 42 | 14 |
| ≥ 65 | 67 | 21 | 9 |
| ≥ 70 | 38 | 9 | 4 |
| ≥ 74 | 19 | **5** | 4 |
| ≥ 78 | 0 | 0 | 0 |

### Two things the brief did not state, found while measuring

**(a) A third of all sightings happen after the US close.** Scrape timestamps
cluster at 06:00–14:00 UTC but **2,201 of 12,728 rows are at or after 20:00 UTC**
(16:00 ET) — the 20:00, 21:00 and 23:00 buckets. Entering those at the same
day's close would be look-ahead on roughly one sighting in six. This drove the
`PORTFOLIO_SESSION_CLOSE_UTC_HOUR` rule and, for the outcome-derived backfill
(which carries no time at all), the decision to enter one session late.

**(b) `signal_outcomes` reaches back five weeks further AND carries higher
scores** (max 85.1 vs 76.6 in `signals`), because those rows were scored under
the pre-audit regime and are never recomputed. Using them extends the curve from
9 days to 43. It also means the ≥ 74 threshold does not mean exactly the same
thing on both sides of 2026-08-15. The chart marks that boundary with a
`Live ab …` divider; it is a real discontinuity, not a cosmetic one.

### The entry universe that results

Union of both sources, deduplicated to one candidate per (ticker, session):

| Threshold | entries | distinct days | distinct tickers |
|---|---|---|---|
| ≥ 60 | 52 | 17 | 24 |
| ≥ 65 | 31 | 17 | 18 |
| ≥ 70 | 18 | 14 | 10 |
| **≥ 74** | **11** | **10** | **8** |
| ≥ 78 | 4 | 4 | 2 |

Eleven candidate sightings at the default threshold, of which 7 became
positions: `GLOO`, `ELV`, `COSM`, `GLSI`, `SCTX`, `XAIR`, `INV`. `PNAQ` returned
HTTP 404 from Yahoo and is reported as not tradable rather than dropped. The
rest were the re-entry cooldown doing its job (`GLOO` was flagged on three
consecutive days, `INV` twice).

**Consequence accepted:** 6M and 1Y are `n/a · N days to go`, CAGR needs 48 more
days, Sharpe needs 18 more. The windows are built and will fill themselves.

---

## 2. What was built

| Layer | File | Note |
|---|---|---|
| Rules (pure) | `src/lib/portfolio-rules.ts` | Sizing, triple barrier, day loop, statistics. No Electron/Node/DOM — which is what makes "no look-ahead" and "deterministic" testable. |
| I/O | `electron/portfolio.ts` | Candidates, price-cache top-up, append-only persistence. |
| Prices | `electron/prices.ts` | The single adjusted-close source. `performance.ts` and `label-outcomes.ts` now share it instead of carrying three copies of the same Yahoo parsing. |
| Schema | `electron/database.ts` | `price_history`, `portfolio_equity`, `portfolio_positions`, `portfolio_events` — additive via `PORTFOLIO_SCHEMA`, so `SCHEMA` and `runMigrations()` cannot drift. |
| Tests | `tests/portfolio.test.ts` | 46 tests. |
| Audit | `scripts/verify-portfolio.ts` | 19 checks, read-only. |
| Sweep | `scripts/portfolio-sweep.ts` | Sensitivity, read-only. |
| UI | `src/components/Portfolio/*` | Tab, chart, statistics, trades, rulebook, runtime rule editor. |

### Bugs the tests and the screenshots caught

These are listed because they are the reason to trust the rest, not to pad the
document. Every one of them would have produced a plausible-looking but wrong
chart.

1. **A position sitting exactly on +20% did not take profit.** `120 / 100 - 1` is
   `0.19999999999999996` in IEEE-754. The same slip hid the −10% stop and the
   +15% trailing arm. Fixed with an explicit `BARRIER_EPS`.
2. **`equity = cash + spy + positions` was off by up to 1.5 cents**, because the
   three components were rounded independently of the total. The components are
   now rounded first and the headline is their sum, so the identity is exact.
3. **A signal from the most recent session was reported as "not tradable."**
   Friday evening's signal has no Monday close yet; it is now *pending* until its
   full 5-day search window has actually elapsed. Without this, the data-quality
   line permanently accused healthy tickers.
4. **The backfill→live divider never rendered.** `liveStart` is 2026-08-15, a
   Saturday, and a `ReferenceLine` on a category axis has to name an actual tick.
   Snapped forward to the first session in view.
5. **Cash could go to −1e-12** when a buy was funded by selling exactly the whole
   SPY block, which would have failed the "cash is never negative" invariant on a
   rounding artefact.
6. **The headline return disagreed with the dollars beside it.** "Since start"
   was measured from the first curve point, which is already NET of one side of
   entry slippage — $9,995 of a $10,000 commitment, because the book and the
   benchmark both buy that morning. The dollar figure next to it was measured
   from the $10,000. So the page printed −1.26% beside −$130.60 (−1.31%), and
   $10,147.25 beside +1.52% (+1.47% on the money committed). Both percentages
   now measure from the capital committed, and the chart's max window with them.
   The lead is unmoved at −2.78%: both series paid the same entry cost, so it
   cancels in the difference and only the absolute figures were wrong. The 7d
   and 30d windows are unchanged — they anchor mid-book, where the cost sits
   inside both ends. Drawdown, volatility and Sharpe stay on the curve itself:
   they describe the path the book took once established, and an execution cost
   is not a session's return.
7. **Three trades on one session drew three dots on one pixel.** The chart
   pushed one marker per TRADE, keyed by `kind-date` — so 2026-08-31, which
   bought LIEN and REFI and sold GLSI, collided in React and rendered as a
   single dot that said nothing about any of them. Markers are now grouped by
   session and drawn as the standard idiom (buy below the line pointing up, sell
   above pointing down), and the tooltip names every ticker traded that day.
8. **A "nice" axis domain was still labelled on an ugly step.** Handing Recharts
   −4% … +6% and letting it choose left the axis reading −4.0 / −1.5 / +1.0 /
   +3.5 / +6.0 — a 2.5-point step nobody reads in their head, which also stepped
   straight over zero. The ticks are now generated on the same 1/2/5 step as the
   domain, so zero is always a gridline. Zero also lost its `+` sign: "+0.0%"
   reads as a rounded-down gain.
9. Presentation: unrounded Y-axis domain producing meaningless ticks, the last
   X label clipped (again at 393px, where a 22px right gutter cut "Aug 31, 2026"
   to "Aug 31, 202"), the Y axis sliced off at 360px, the closed-trades table
   overflowing its card by 28px, and `Einstellungen` no longer fitting the tab
   bar with a sixth tab (shortened to `Setup`/`Settings` — the label, not the
   touch target).

---

## 2b. The 2026-09-01 reset

Everything in section 3 below was measured on a **backfill**: the rules replayed
over signal history that had already happened. That was the right way to build
the thing — you cannot debug a simulator against data you do not have — but it
cannot be the evidence for it. The entry threshold, the barriers and the hold
cap were all chosen with that history on screen, so quoting its return is
quoting the fit, not a result.

So the book was reset. `PORTFOLIO_INCEPTION = '2026-09-01'`: the curve, the
positions and the events were cleared, and from that day the book only ever acts
on signals that arrived after the rules were fixed. Signals older than the
inception date are **dropped, not deferred** — resolving a seven-week-old
sighting forward would buy it on opening day at a price that had already moved
without it, which is the one thing `earliestEntryDate` exists to prevent, and it
would land on day one where it reads as alpha. Verified against the real DB with
an inception of 2026-08-24: 21 of 29 candidates dropped, curve starting exactly
on the inception date, zero positions or events before it, and the dropped
tickers correctly absent from `untradable` — a dropped signal is not a missing
price.

`inceptionDate` lives in the stored config, not in a constant, so moving it
invalidates the curve through the same `sameConfig` check every other rule uses.
Nothing else was touched: signals, labeled outcomes, insider trades and the
price cache are all still there, and the numbers below stay on the record as
what the rehearsal looked like.

The figures in section 3 are therefore **historical**. The live book starts from
zero trades on 2026-09-01, and until it has a few dozen closed trades it will
say very little — which is the honest position, not a regression.

---

## 3. The result

Window **2026-07-10 → 2026-08-21**, 31 sessions. Prices are adjusted closes; the
last available session is Friday 2026-08-21.

| | Portfolio | S&P 500 (SPY) | Difference |
|---|---|---|---|
| Final value | **$10,239.91** | $10,137.59 | **+$102.32** |
| Return (max) | **+2.45%** | +1.43% | **+1.02 pp** |
| 30 days | +3.09% | +2.45% | +0.64 pp |
| 7 days | −2.05% | −1.37% | −0.68 pp |
| 6 months / 1 year | `n/a · 140 d` | `n/a · 323 d` | — |
| Max drawdown | −3.67% | −3.38% | −0.29 pp |
| Volatility (ann.) | 14.4% | 12.5% | +1.8 pp |
| CAGR / Sharpe | `n/a` (needs 48 / 18 more days) | | |

Trade record: **6 closed, 1 open · hit rate 67% (4 of 6) · Ø hold 16 days ·
Ø win +14.74% / Ø loss −10.43% · best GLSI +25.21% / worst COSM −10.74% ·
Ø trade alpha vs SPY +3.99% (n = 6) · currently 5.8% invested.**

The book was ahead of SPY on **28 of 31 days**.

### Every trade

| Ticker | Entry | Exit | Score | Entry px | Exit px | Return | P&L | α vs SPY | Held | Reason |
|---|---|---|---|---|---|---|---|---|---|---|
| GLOO | 2026-07-13 | 2026-08-12 | 85.1 | $3.162 | $3.408 | +7.80% | +$65.55 | +4.69% | 30 d | time |
| ELV | 2026-07-20 | 2026-08-19 | 74.1 | $382.42 | $398.25 | +4.14% | +$20.61 | +0.51% | 30 d | time |
| GLSI | 2026-07-31 | 2026-08-12 | 75.1 | $13.507 | $16.912 | +25.21% | +$133.32 | +21.80% | 12 d | take profit |
| COSM | 2026-07-31 | 2026-08-19 | 80.1 | $0.216 | $0.193 | −10.74% | −$73.40 | −13.69% | 19 d | stop loss |
| SCTX | 2026-08-03 | 2026-08-06 | 74.5 | $20.850 | $25.397 | +21.81% | +$114.15 | +20.37% | 3 d | take profit |
| XAIR | 2026-08-04 | 2026-08-06 | 77.9 | $6.183 | $5.557 | −10.12% | −$64.70 | −9.76% | 2 d | stop loss |
| INV | 2026-08-21 | *open* | 76.6 | $1.510 | — | −0.05% | — | — | 0 d | — |

All prices include the 0.05% per-side slippage. Six distinct tickers in six
trades — no single name is carrying the record through repetition.

### Data quality

- 0 signals skipped for lack of cash, 0 skipped at the position cap.
- 1 ticker without price data: **PNAQ** (Yahoo 404). Reported in the UI, not
  silently dropped.
- 0 suspect price points rejected by the |Δ| ≤ 60% screen.
- 0 stored days drifted after a price restatement.

`npm run verify:portfolio`: **19 of 19 checks pass**, including the NAV identity
on every day, no gaps against SPY's own calendar, the benchmark reproducible as
a plain buy & hold, and a re-simulation of the stored window reproducing the
stored curve to the cent.

---

## 4. Does the terminal beat the S&P 500? — and how sure is that

**On the data available: yes, by 1.02 percentage points over six weeks. That
result is not statistically distinguishable from luck, and it should not be
quoted as evidence that the signals work.**

The reasons, in order of how much they matter:

**The sample is six trades.** Per-trade alpha: mean +3.99%, standard deviation
14.83%, standard error 6.05%, **t = 0.66**, 95% confidence interval
**−7.9% … +15.9%**. An interval that wide and that firmly straddling zero is the
statistical way of saying "this measurement contains almost no information."
Roughly 60 trades of similar dispersion would be needed before a +4% mean alpha
cleared the usual bar — at the current rate of about half an entry per trading
day, that is a year or more of accumulation.

**One trade is larger than the entire lead.** GLSI alone realized **+$133.32**;
the whole advantage over SPY is **+$102.32**. Remove that single position and
the portfolio trails the index. A result that hinges on one of six observations
is a story about one company, not about a scoring model.

**The window is one regime.** Six weeks of a gently rising market (SPY +1.43%).
Nothing here says anything about how these rules behave in a drawdown, and the
book's slightly higher volatility (14.4% vs 12.5%) and slightly deeper drawdown
(−3.67% vs −3.38%) hint that it would fall a little harder.

**Two-thirds of the history is backfill under an older scoring regime.**
2026-07-10 → 08-14 comes from `signal_outcomes`, whose scores were assigned
before the 2026-08 audit and reach 85.1 where the live scorer now tops out at
76.6. The threshold of 74 is therefore not literally the same filter on both
sides of the divider.

**What is genuinely encouraging**, stated as an observation rather than a
result: the direction is consistent. The book led SPY on 28 of 31 days, the hit
rate is 4 of 6, and the per-trade alpha is positive at every entry threshold from
70 upward. None of that is significant, but none of it is contradictory either.

**What would make this convincing:** ~60 closed trades (about a year at the
current signal rate), spanning at least one drawdown, all of it from live
`signals` rows rather than the backfill. The curve is append-only and the CI job
extends it three times a day, so this document's successor will have that data
without anyone doing anything.

---

## 5. Parameter sweep

> **Superseded for the exit rules (v1.5.0).** The tables below were produced with
> the v1.4.0 barrier set (+20% / −10% / 30 d) and a sweep whose longest hold row
> could not bind inside a 31-session window. The exit parameters were re-derived
> from the published literature in
> [EXIT-STRATEGY.md](EXIT-STRATEGY.md); §7 there explains why the decay pattern
> recorded in §7.1 below is not a horizon result. The entry-threshold and
> cash-policy findings here still stand.


`npm run portfolio:sweep` (read-only). Window 2026-07-10 → 2026-08-21, 31
sessions, 56 candidate sightings at score ≥ 60, 24 tickers. **Benchmark over the
same window: +1.43%.**

### Entry threshold

| Variant | Entries | Closed | Final $ | Return | vs SPY | Hit | Ø α | n | Max DD |
|---|---|---|---|---|---|---|---|---|---|
| score ≥ 60 | 20 | 12 | 10,250.92 | +2.56% | +1.13% | 50% | +1.20% | 12 | −4.94% |
| score ≥ 65 | 15 | 10 | 10,199.07 | +2.04% | +0.62% | 50% | +0.86% | 10 | −4.80% |
| score ≥ 70 | 9 | 7 | 10,210.96 | +2.16% | +0.73% | 57% | +2.50% | 7 | −3.72% |
| **score ≥ 74** | **7** | **6** | **10,239.91** | **+2.45%** | **+1.02%** | **67%** | **+3.99%** | **6** | **−3.67%** |
| score ≥ 78 | 2 | 2 | 10,093.23 | +0.98% | −0.44% | 50% | −4.50% | 2 | −3.62% |

### Time stop

| Variant | Entries | Closed | Final $ | Return | vs SPY | Hit | Ø α | n | Max DD |
|---|---|---|---|---|---|---|---|---|---|
| hold ≤ 10 d | 7 | 6 | 10,239.99 | +2.45% | +1.02% | 50% | +3.62% | 6 | −3.70% |
| hold ≤ 20 d | 7 | 6 | 10,286.34 | +2.91% | +1.49% | 67% | +4.83% | 6 | −3.67% |
| **hold ≤ 30 d** | 7 | 6 | 10,239.91 | +2.45% | +1.02% | 67% | +3.99% | 6 | −3.67% |
| hold ≤ 45 d | 7 | 4 | 10,262.21 | +2.67% | +1.25% | 50% | +4.68% | 4 | −3.67% |
| hold ≤ 60 d | 7 | 4 | 10,262.21 | +2.67% | +1.25% | 50% | +4.68% | 4 | −3.67% |

### Take-profit / stop-loss

| Variant | Entries | Closed | Final $ | Return | vs SPY | Hit | Ø α | n | Max DD |
|---|---|---|---|---|---|---|---|---|---|
| +15% / −8% | 7 | 6 | 10,188.30 | +1.93% | +0.51% | 67% | +2.34% | 6 | −3.67% |
| **+20% / −10%** | 7 | 6 | 10,239.91 | +2.45% | +1.02% | 67% | +3.99% | 6 | −3.67% |
| +25% / −12% | 7 | 5 | 10,248.08 | +2.53% | +1.11% | 80% | +4.35% | 5 | −3.67% |
| +30% / −15% | 7 | 5 | 10,177.15 | +1.82% | +0.40% | 80% | +1.72% | 5 | −3.67% |

### Cash policy

| Variant | Final $ | Return | vs SPY | Ø α | Max DD |
|---|---|---|---|---|---|
| **cash → SPY** | 10,239.91 | +2.45% | +1.02% | +3.99% | −3.67% |
| cash idle | 10,197.63 | +1.98% | +0.55% | +3.99% | −0.81% |

Note that **Ø trade alpha is identical** under both policies, which is the point
of the cash-policy design: where the idle money sits changes the headline return
and the drawdown, but not the measured contribution of the signals.

### Time stop × entry threshold (Ø trade alpha / n)

|  | 10 d | 20 d | 30 d | 45 d | 60 d |
|---|---|---|---|---|---|
| ≥ 60 | **+2.2%** /12 | +1.3% /12 | +1.2% /12 | +0.9% /10 | +0.9% /10 |
| ≥ 65 | **+2.7%** /10 | +1.7% /10 | +0.9% /10 | +0.4% /8 | +0.4% /8 |
| ≥ 70 | **+4.1%** /7 | +3.2% /7 | +2.5% /7 | +2.5% /5 | +2.5% /5 |
| ≥ 74 | +3.6% /6 | **+4.8%** /6 | +4.0% /6 | +4.7% /4 | +4.7% /4 |
| ≥ 78 | **+0.7%** /2 | −1.6% /2 | −4.5% /2 | −13.7% /1 | −13.7% /1 |

**How to read all of this:** as *sensitivity*, not as a ranking. Every row rests
on 2–12 trades and one position moves a whole column by percentage points.
Picking the best-looking cell would be fitting to noise, which is precisely the
failure mode this instrument exists to avoid.

The rule set before the sweep ran was: change a default only when a variant wins
across **every** threshold step, never on the average. Nothing does, so nothing
changed. Section 7 records where the evidence nevertheless leans.

---

## 6. Decisions taken (things the brief left open)

1. **Backfill from `signal_outcomes`, entered one session late.** Those rows
   carry a date but no timestamp, and one sighting in six is post-close. Assuming
   the close had already passed is the only assumption that cannot manufacture
   look-ahead. It costs return on the backfill; that is the correct direction for
   an instrument whose job is to be believed.
2. **Post-close cutoff at 20:00 UTC, fixed, not timezone-derived.** That is 16:00
   ET under EDT; under EST the real close is 21:00 UTC, so the rule errs one hour
   early for four winter months. Erring early can only *delay* an entry. A live
   timezone lookup would make the curve depend on the machine's tz database, and
   reproducibility is worth more than that hour.
3. **`price_history` rewrites a ticker from a single fetch.** The brief's cache
   could be read as write-once. Adjusted closes are restated for the *whole*
   history after a split, so appending new rows to old ones welds a pre-split
   series onto a post-split one and manufactures a −50% day. One fetch per ticker
   per calendar day keeps each series internally consistent.
4. **The curve is append-only; positions and events are rewritten.** A stored day
   is never modified, so a later restatement cannot move a point a reader already
   saw. Drift is detected, counted into `restatedDays` and surfaced in the UI.
   Positions and events are a projection of the same deterministic run, so they
   are regenerated — except `suspect_price` events, which record what a *fetch*
   rejected and no simulation could reproduce.

   **Correction (2026-08-31).** This decision was wrong as stated, and the
   asymmetry it describes is exactly what broke. Rows kept while positions and
   events are replaced only holds together while the *rules* stay fixed. When
   v1.5.0 changed the exit rules, the new simulation was appended to rows built
   under v1.4.0's, and the published curve became a splice of two strategies:

   - Four July positions the old rules had closed reappeared on 2026-08-24 —
     the book went from 1 open position to 7 **with no buy or sell recorded** —
     carrying weeks of accumulated gain booked into that single day: **+2.90pp
     against SPY in one session.**
   - That artifact was **7.4× the entire +0.39% lead** the page was reporting.
     Chained out, the same curve *trailed* SPY by 2.49pp.
   - The last row stopped matching the position table displayed beside it
     ($3,802.66 vs $4,122.89), because the newest day is marked from intraday
     prices and was being frozen by the first run of the day.
   - `restatedDays: 17` of 37 days was the system reporting all of this as
     "price restatements", which they were not.

   Now: settled days stay append-only, but the newest (provisional) day is
   always recomputed, and the whole curve is discarded and re-simulated when the
   config changes or when `CURVE_BUILDER_VERSION` moves. After the rebuild the
   curve reproduces exactly — zero position changes without an event, and the
   last row matches its position table to the cent.
5. **Suspect prices are dropped, not stored with a flag.** The schema in the
   brief has no flag column, and `portfolio_events.kind` already has
   `suspect_price`. The gap a dropped point leaves is handled by the same
   next-session search that handles holidays.
6. **Two books are simulated in lockstep.** `equity` follows the active cash
   policy and `equity_idle` the uninvested-cash variant. Sizing keys off current
   equity, so the two genuinely diverge in share counts — valuing one book two
   ways would have been a fiction.
7. **The post-scrape hook lives in `triggerScrape()` (main.ts), not in
   `scheduler.ts`.** That is the actual post-scrape seam and covers manual
   refreshes as well as cron runs. Fire-and-forget with a `catch`, exactly like
   the existing web-publish call.
8. **The sweep fetches missing prices into memory.** It reaches below the live
   entry threshold and needs tickers the sync never cached. The database stays
   read-only, as the repo convention requires for analysis tools.
9. **`emptyPortfolioState()` lives in the pure module.** Both the main process
   and the browser build need it and neither can import the other's copy.
10. **Bottom-bar label shortened to `Setup` / `Settings`.** Six tabs at 360px
    leave ~60px each and `Einstellungen` no longer fitted. The brief's
    instruction was explicit: shorten labels, never touch targets.
11. **`vitest` was installed.** It is declared in `package.json` but was absent
    from `node_modules`, so `npm test` and `npm run typecheck` were both failing
    before any of this work started.
12. **The rule editor lives in the rules card, not in Settings.** The brief put
    runtime configuration "in Settings"; it sits next to the values it changes
    instead, because that card already lists every parameter and a form in a
    different view would have duplicated all sixteen labels. Percentages are
    edited as percentages (20, not 0.2) — asking for 0.2 next to a card reading
    "+20%" is how a stop-loss silently becomes a 10× stop-loss. Applying rebuilds
    the curve and says so first. Same reasoning for the Rebuild button being on
    the tab rather than in Settings; it is confirmed explicitly either way.
13. **The closed-trades table scrolls the last ~30px at 1440px.** Eleven columns
    need ~1094px in a ~1066px card. The gutters come from an app-wide
    `th, td { padding: 10px 14px !important }` in `globals.css`, so narrowing
    them locally is inert — and overriding that rule for one table would make it
    disagree with every other table in the app. Left scrolling, which is what the
    container is for.

---

## 7. Recommendations that differ from the brief

The brief's defaults are implemented exactly as written. These are the places
where the measurements point somewhere else.

### 7.1 The time stop is probably too long — but not provably

> **Reversed in v1.5.0.** This recommendation was drawn from a sweep whose 45-day
> and 60-day rows printed identical numbers, because the time stop never bound
> inside a 31-session window — they were the same experiment twice, not two
> horizons. The insider-trading literature measures the drift over six to twelve
> months, and the marginal alpha is still positive at day 250. The time stop went
> to **90 calendar days**. Full argument and sources:
> [EXIT-STRATEGY.md](EXIT-STRATEGY.md) §7. The text below is kept as the record
> of what was believed at v1.4.0.

**Implemented: 30 calendar days (as specified). Recommended: 20, or 10.**

At four of five entry thresholds, per-trade alpha decays monotonically with
holding length:

| | 10 d → 60 d |
|---|---|
| ≥ 60 | +2.2% → +1.3% → +1.2% → +0.9% → +0.9% |
| ≥ 65 | +2.7% → +1.7% → +0.9% → +0.4% → +0.4% |
| ≥ 70 | +4.1% → +3.2% → +2.5% → +2.5% → +2.5% |
| ≥ 78 | +0.7% → −1.6% → −4.5% → −13.7% → −13.7% |

Only the default row (≥ 74, n = 6) breaks the pattern, peaking at 20 days. That
pattern matches the **independent** evidence the brief itself cites from
`signal_outcomes` — alpha peaking near day 10 and decaying by day 20 — which
makes it two separate measurements pointing the same way rather than one.

It is still not enough to act on: the rule agreed in advance was consistency
across *all* threshold steps, and 30 days also happens to be what the two
30-day time-stop exits (GLOO +7.80%, ELV +4.14%) needed to finish positive. If
this pattern survives another 30 trades, shorten the time stop to 20 days.

### 7.2 Report the trade alpha with its confidence interval, not alone

The brief calls Ø trade alpha "the most meaningful number on the page," and it
is — it is immune to cash drag and to when the window happens to start. But at
n = 6 it is also the number most likely to be over-read. The UI shows `n` next
to it and flags small samples; **the report should be the only place the figure
appears without its interval**, and this one prints t = 0.66 and −7.9% … +15.9%
directly underneath it. Consider adding the interval to the tab itself once
`n ≥ 20`, where it starts to be informative rather than merely discouraging.

### 7.3 The 74 threshold is a compromise, and it will need revisiting

74 is well chosen for *today*: it is the highest level that still produces a
non-empty sample. But it sits 3.4 points above the live scorer's all-time
maximum minus nothing — the ≥ 78 row already collapses to two trades and −4.50%
alpha. If the scoring model is ever recalibrated upward (the audit left the
saturating normalization in place), this threshold changes meaning silently.
Tie it to a percentile of the trailing score distribution rather than an
absolute number once there is enough history to compute one.

### 7.4 A single 5-day price-search window is doing two different jobs

`PORTFOLIO_PRICE_SEARCH_DAYS = 5` decides both "how long to wait for an entry
fill" and "how long before an open position counts as delisted." Those deserve
different values — a week of no prints on an open position is a much stronger
signal than a week between a signal and its first tradable close. Not changed,
because no position in this window hit either path for a real reason.

---

## 8. Verification

| Command | Result |
|---|---|
| `npm run typecheck` | clean (both projects) |
| `npm test` | **349 passed** (46 new in `tests/portfolio.test.ts`) |
| `npm run verify:portfolio` | **19/19 checks pass** |
| `npm run build` | ok |
| `npm run build:web` | ok — `EquityChart` is a 3.5 kB lazy chunk, Recharts' 383 kB stays out of the main bundle |

The tests that matter most, and what each would catch:

- **No look-ahead** — a signal seen at 21:00 UTC on day *D* fills at day *D+1*'s
  close, and an entry price can never predate the sighting even when the stock
  was cheaper before it.
- **Determinism** — the same inputs produce a deep-equal curve, trade list and
  event log, and the result does not depend on the order candidates arrive in.
- **Idempotence, in practice** — a second `portfolio:sync` over the same period
  wrote 0 new days and produced identical figures.
- **Split safety** — the same 2:1 split triggers a stop loss on raw closes and
  does nothing on adjusted closes. Both directions are asserted, so the test
  fails if the protection is removed *or* if the fixture stops being meaningful.
- **Cash never negative, weights bounded, ≤ 20 positions, one lot per ticker.**
- **Statistics withhold** rather than extrapolate when the history is too short.
- **Barrier configurability** — the same fixtures under a +30%/−15%/10-day rule
  set exit at the new levels, so the constants are genuinely wired through
  rather than merely declared.

Screenshots at 1440×900 and 360×800 for the new tab and for Dashboard,
Watchlist, History and Settings were taken from the running dev server; the
pre-existing views are unchanged apart from the new sidebar/tab entry.

---

## 9. What happens next without anyone doing anything

`scrape.yml` runs three times each weekday: scrape → label outcomes →
**portfolio sync** → build → deploy. Each run extends the curve by a session,
labels whatever has ripened, and republishes `portfolio.json`. The statistics
windows fill themselves:

| | needs | available on 2026-08-23 |
|---|---|---|
| Sharpe | 60 days | 43 — **~18 days away** |
| CAGR | 90 days | 43 — **~48 days away** |
| 6-month window | 182 days | 43 — ~140 days away |
| 1-year window | 365 days | 43 — ~323 days away |

The honest re-read of this report is due when the trade count reaches roughly 20
(the point at which the small-sample flags in the UI switch off), and the
verdict in section 4 should be revisited then — in either direction.
