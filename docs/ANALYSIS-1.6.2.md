# Stock analysis 1.6.2

Only evidence levels 1–3 remain. Level 3 still requires an absolute cashflow valuation, independently sourced applicable discount rate and sufficient inputs. Neither the number of optional valuation models nor an external provider price promotes the evidence level. Previously persisted level-4 records are recalculated at their original observation date.

The scraper fetches public valuations from Alpha Spread (base-case DCF/relative blend), GuruFocus (GF Value), and ValueInvesting.io (Peter Lynch formula). ValueInvesting.io was also a user-supplied reference in the earlier NVDA discussion. The third source supplies a working alternative while GuruFocus blocks direct requests. Fair Value Calculator's homepage loads, but its public stock-search request returned a browser challenge; no unrelated featured-stock value is used.

Each source retains provider, exact URL, method, currency, retrieval timestamp, explicit valuation date when supplied, and status. A quotation and supported US venue must be verified first. Exact ticker/visible model labels are validated; analyst targets, script-only data and currency mismatches cannot become provider fair values. Non-US adapters are explicitly unsupported rather than guessed. Failures preserve the internal calculation. Blocking/rate limits trigger a 15-minute provider cooldown; successful references have a 24-hour in-process cache. Requests are bounded and inherit analysis cancellation.

The UI displays the provider price, `(internal/provider - 1) × 100`, and `(market/provider - 1) × 100`. Opposing market-price assessments appear prominently in analysis and alert cards. Differences above 25% prompt reviewing assumptions; reference models are never silently averaged into the internal price, scoring weight, or evidence level. Dated reference values remain labelled; values older than seven days by explicit source date are excluded from numerical comparison.

## Scrapling execution status

GitHub's public scrape enables pinned Scrapling 0.4.15 for OpenInsider and SECForm4. The fundamental-history collection uses the Python Scrapling adapter. The catalogue refresh now also enables it for the three external reference sources. This is a mixed scraper: remaining providers and quotes keep their existing native HTTP/Playwright/API adapters. An Actions "success" is not proof of complete provider coverage; published per-source health/status must be checked.

The packaged desktop does **not** bundle Python or Scrapling. Desktop scrapes and independent stock analyses work through native HTTP/Playwright; the new external comparison uses native HTTP there. Source deployments can explicitly enable Scrapling when Python and scripts exist, using `SCRAPLING_ENABLED=1` and `SCRAPLING_PYTHON`. This optional path is not advertised as a packaged-desktop capability. Login-gated sessions remain distinct from Scrapling public-page fetching.

Observed local live tests on 2026-10-04: Alpha Spread and ValueInvesting.io supplied AAPL, NVDA, PEP and MCD prices through Scrapling. GuruFocus returned HTTP 403. Fair Value Calculator's stock-query endpoint was challenged. No access control or challenge was bypassed.
