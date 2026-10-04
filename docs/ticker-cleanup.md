# Ticker cleanup (2026-09-26)

Malformed symbols are quarantined using conservative rules in
`src/lib/ticker-quality.ts`. The original signal, outcome and trade rows are
retained. `ticker_quarantine` records the reason and observation timestamps.
Normal existing retention rules and immutable history backups still apply.

Invalid syntax and the reviewed non-symbol values `NVDAEARNINGS` and `GLASFUNDS`
are excluded from active signals, new scoring work, portfolio candidates and
outcome labeling. A syntactically plausible ticker is never quarantined merely
because its price lookup fails. Those failures remain in update health.

CYBN -> HELP is verified by the issuer's January 5, 2026 announcement:
https://ir.helus.com/news-releases/news-release-details/helus-pharma-propels-therapeutic-innovation-mental-health-and

Portfolio candidates on/after that effective date use HELP as one security;
the engine's existing one-position rule prevents duplicate CYBN/HELP exposure.
Price lookups for the former symbol use the continuing security's adjusted
series. Source rows and existing outcome identities are not renamed in place.

Builder version 5 recalculates the derived portfolio consistently after identity
repair. Before the first rebuild, `portfolio_revisions` archives the previous
complete state (including the insider-only experiment) under
`ticker-cleanup-v1`. INSERT OR IGNORE prevents retries from replacing this archive.
Historical performance may change as a result of corrected security identities.

Regression coverage includes conservative classification, effective dates,
one-position behavior, price-provider routing, raw-row preservation across
SQLite reopen, active-signal deduplication and immutable revision snapshots.
