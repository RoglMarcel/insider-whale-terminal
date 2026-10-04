# Fair value 1.6.1

The prominent value is now a central fair value, rather than the full stress
scenario envelope. The envelope remains available as sensitivity analysis and
is not artificially narrowed. A market discount of more than 5% to the central
value is classified as undervalued; the additional confidence-dependent margin
of safety is a separate conservative entry target. The score boost still requires
that margin, so this presentation change does not waive the entry safeguard.

Market deviation is `(price / fairValue - 1) * 100`; negative means undervalued.
Potential return is `(fairValue / price - 1) * 100`. Their denominators differ and
the UI labels them separately. Original dates and stale status are retained.

Per-share equity cashflow uses an EPS-growth proxy, falling back to revenue
growth only when EPS guidance is missing. Total FCFF uses revenue growth.
Neither proxy is direct free-cashflow guidance: buybacks, accounting effects and
changing reinvestment can cause differences. Forecast growth remains capped at
25%, fades after three years to 2.5% over seven years, and missing growth is 2%.

For USD observations with usable beta, the default equity discount scenario is
`max(7%, 4.25% + (0.67 × beta + 0.33) × 5%)`. The risk-free rate, premium, beta
adjustment and floor are disclosed policy assumptions, not observed current
market inputs. They do not qualify the valuation for level 3. An independently
sourced cost of equity takes precedence. Other unsupported currencies retain
the disclosed 10% scenario assumption. CAPM structure reference:
[Damodaran](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/definitions.html).

Cashflow and separately sourced earnings-benchmark families each contribute one
central estimate. DDM remains a cross-check when cashflow is available, since it
values the same distributions. The stage-1 EPS fallback is the simplified
Graham heuristic `EPS × (8.5 + 2 × growthPercent)`, with forecast growth capped
at 10% and a 2% missing-growth default. It omits the bond-yield adjustment, is
explicitly a rough policy heuristic and receives low confidence weight.

Every alert card contains a fair-value block. A shared static summary avoids
hundreds of full financial-data downloads; the detail fetches the complete
stock analysis independently of the historical score. The scheduled catalogue
imports existing signal valuations, includes all active alert tickers and gives
missing alert valuations refresh priority. Desktop and scoring use preserved
source-dated snapshots during outages. Historical signal scores are not rewritten
by a UI refresh. A missing numerical financial basis is explicitly unavailable,
not invented from the stock price; stale cached numbers are labelled stale and
remain score-neutral. All 26 models retain explicit missing-input states.

The older detailed provider panel is secondary and uses the current analysis as
its fallback when a separate provider document cannot be loaded.
