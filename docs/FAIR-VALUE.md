# Fair-value enrichment

> Historical implementation notes for the initial prototype. Superseded by
> [Analysis 1.6](ANALYSIS-1.6.md), including scheduled static delivery, actual
> market quotes, global search, revised growth scenarios and safety margins.

## Standalone Analyse tab

Desktop and mobile navigation include **Analyse**, independent of alert membership.
Enter a US-listing ticker (AAPL, MSFT, BRK.B). The report includes a model-based
cheap/expensive/watch assessment, entry threshold, earnings, cash flow, balance
sheet and analyst context, provenance and model coverage. Low confidence and
missing data prevent categorical purchase claims. Company-name/ISIN search and
non-US currency conversion are not implemented.

Desktop uses the trusted Electron IPC boundary. Individual analyses do not
modify alerts or run a full scrape. The service deduplicates concurrent requests,
limits concurrent tickers to four and caches at most 200 results for five minutes
(one minute for unavailable data).

For local web development, run `npm run analysis:serve` and `npm run dev:web`
in separate terminals. Vite proxies `/api/analysis` to port 8787. The existing
static GitHub Pages host cannot execute arbitrary live scrapes. Production needs
this Node service behind HTTPS, with `VITE_ANALYSIS_API_URL` set to its full
`https://.../api/analysis` URL **when building the web app**. Configure
`ANALYSIS_ALLOWED_ORIGINS` to the website origin (comma-separated), and optionally
`ANALYSIS_PORT` / `ANALYSIS_HOST`. Default binding is loopback only. An edge proxy
should preserve/implement public rate limits; the service uses socket IP and
does not trust forwarded headers. It allows GET only, validates symbols and
never accepts upstream URLs. No secrets belong in the browser build.

If the live API is unavailable, the website can display an existing published
alert valuation, explicitly labeled as a snapshot. Snapshots older than a day
do not receive a current purchase assessment. Unknown tickers show a retryable
service error instead of fabricated sample results. No production hosting was
changed by adding this feature.

New scrape sessions attach a versioned valuation snapshot to every candidate's
`ScoreBreakdown.fairValue` before scoring. Existing SQLite JSON persistence and
web exports preserve it. Old signals are not retrospectively valued using future
data. Signal detail shows the inputs, retrieval URLs/times, model statuses,
assumptions, price corridor, safety margin, and valuation recommendation.

## Live data and coverage

- Public Stock Analysis US-listing statistics; Finviz quote snapshot fallback.
- Only supported exact table labels are accepted. Signs and missing values are
  preserved. Unknown/non-USD Stock Analysis pages and mismatched titles are rejected.
- Same-page market cap / shares provides an approximate reference quote. FCFE per
  share is derived from FCF plus net borrowing. These derivations are disclosed.
- Quotes/fundamentals are snapshots, not independently verified annual filings.
  Analyst EPS growth is capped at 3%; analyst targets are displayed as inputs,
  never treated as fair value. No paid-content or login bypass.
- Four concurrent jobs, 8-second request deadlines, a 90-second phase limit;
  deferred candidates receive an explicit unavailable result. Successful snapshots
  are reused for six hours, unavailable results for fifteen minutes.

## Calculation policy

Positive EPS fallback: 10–15 times earnings. Positive book value fallback:
0.5–1.0 times book. These are explicit policy assumptions, not observed industry
averages. Losses never become positive earnings. A quote alone cannot establish
fair value: with no usable basis the result is unavailable and score-neutral.

Cashflows use five annual discounted periods and a terminal value. Default growth
is 2%, terminal growth 2%, default cost of equity 12%. Enterprise DCF bridges cash
and debt to equity; FCFE does not add cash a second time. A sourced WACC is not a
substitute for cost of equity. Default rates do not qualify a model for level 3.

Supported calculations: FCFF/FCFE DCF, Gordon/two-stage DDM, historical/peer/forward
P/E, PEG, Shiller P/E, EV/EBIT, EV/EBITDA, P/S, EV/Sales, P/B, P/CF, P/TBV,
dividend yield, and source-supplied NAV/liquidation/replacement/SOTP equity values.
The latter four require independent asset/segment valuations; they cannot be
inferred from generic accounting balances.

**Current limitation:** APV, residual income, EVA, Stuttgart method, and real
options are listed but not implemented. The live adapters do not yet supply
historical peer benchmarks, independent asset/segment valuations, or cost of
equity. Consequently live data normally yields level 1, even when a default-rate
DCF is calculated. Level 2/3 are available to appropriately sourced model inputs;
level 4 is deliberately unreachable. This is not a complete 26-model institutional
valuation engine.

The central estimate uses available DCFs when present, otherwise supported model
values. Correlated DDM outputs do not outvote DCFs. The range includes all selected
model values and ±40%/30%/20% around the central estimate at levels 1/2/3. This is a
policy scenario range, not an empirical confidence interval.

## Alert effect

| Level | Weight | Safety discount on lower bound |
|---|---:|---:|
| 1 | 15% | 50% |
| 2 | 40% | 35% |
| 3 | 75% | 20% |

Fallback estimates halve the weight. Missing quote/valuation has zero weight.
Below the safety-adjusted lower bound the factor is `1 + 0.15 × weight`;
above the upper bound it is `1 − 0.10 × weight`; otherwise it is neutral.
This feeds the existing composite score, alert threshold/rule evaluation and
portfolio signal consumers. Combo alerts retain their existing independent
triggers. Notifications for individual signals/combos include the valuation;
batch/surge notifications retain their summary format.

Changes are not backtest-calibrated. Existing legacy upside-based scoring remains
available for historical/research callers. Unit tests cover arithmetic, signs,
missing data, source failures, cancellation, confidence gates and score wiring.
