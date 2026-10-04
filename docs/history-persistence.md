# Cloud history persistence

The raw database exceeded GitHub's 100 MB Git blob limit. Since 2026-09-11,
cloud runs could deploy fresh JSON but fail to commit their accumulated history.
The old workflow suppressed that error. Earlier failed runners' databases cannot
be recovered from the tracked database alone.

The `Scrape & Publish (web)` workflow now restores the latest complete asset from
the `history-data` prerelease before opening SQLite. After scraping, labeling and
portfolio synchronization it saves a consistent SQLite backup, gzip-compresses it,
uploads it under a unique run/attempt/checksum name, then downloads it and checks
both SHA-256 and SQLite integrity. Saving must succeed before deployment.

Existing assets are never overwritten or automatically deleted. Upload failures
leave the previous backup available and fail the workflow; a 30-day Actions
recovery artifact is also attempted. The compressed file and raw DB are included
in that artifact. Release assets are the durable store; Actions artifacts are
only an emergency recovery path. Storage grows over time: archive old snapshots
before manually pruning them, and retain at least the latest two verified copies.

Only a missing release (HTTP 404) allows initial bootstrap from the tracked
`data/insider-tracker.db`. Authentication, download, checksum and integrity errors
stop the run. An existing but empty release also stops restoration; after a failed
first upload, recover/upload its backup before rerunning. Do not delete the release
to bypass a restore error: that would fall back to old history.

Desktop-marked pushes still use the no-scrape path. Restoration merges the incoming
`signals`, `scrape_log`, and `insider_trades` using the desktop publisher's natural
keys; it preserves cloud portfolio, prices and outcomes. Duplicate rows are not
inserted. Updated desktop builds and `npm run publish:web` send a filtered SQLite export
through `data/desktop-publish/`: gzip parts of at most 32 MiB plus a SHA-256
manifest. The raw database is never staged. Only signals, scrape logs and insider
trades are exported; desktop settings and other private tables are excluded.
The runner checks every part, the combined archive, and SQLite integrity before
merging. Scheduled runs also ingest the latest package idempotently so a skipped
push workflow cannot lose delivery. Desktop-marked commits skip cloud scraping
only on the actual push event, never on later scheduled runs.

Desktop requires an updated app build (or updated source checkout); an already
installed executable does not change when this repository is merged. Existing Git
credentials and configured checkout are reused; no Python or GitHub CLI is needed
on the desktop. The CLI keeps its working history in ignored `tmp/desktop-history`,
seeded from the existing committed DB on first use. Older builds can still deliver
raw databases until they reach Git's limit, but should be upgraded.

The shared `scrape-publish` concurrency group serializes restore/write cycles.
`contents: write` and the built-in `github.token` suffice; no new secret or external
service is required. Snapshots have the same public visibility as the existing
repository database. `history-data` is a prerelease, never the latest app release.

Run the isolated persistence regression checks with:

```sh
python3 -m unittest discover -s tests/persistence -v
```

## Portfolio continuity and missing quotes

The September 21 screenshots show five `data_missing` exits. The committed price
cache ends on September 11 for SPY and the held tickers. The price sync compared
holdings against SPY's old coverage even after refreshing SPY, so holdings could
be skipped. The simulator then treated more than five missing sessions as a sale.
Repeatedly starting from the old Git database makes that failure reproducible.

The repair refreshes holdings against the newly fetched benchmark date. A quote
gap now retains the position, carries forward its last known mark and emits a
quality event; only an actual quote can trigger a price/time exit. The UI labels
stale marks, and no longer substitutes the historical high for the last close.
A missing series does not establish that a security was delisted or sold.

Curve builder version 3 rebuilds derived portfolio history once on the next sync,
removing artificial missing-data sales. Source signals and price history are
preserved. Real stop/trailing/time exits can still occur on available quotes; the
repair does not promise that every formerly held ticker should remain open.

Storage design: keep one logical database so positions, cash, entries and history
remain connected. Compressed, immutable release snapshots avoid the Git blob
limit. If transport chunking is added later, split a consistent backup into
bounded chunks with a checksum manifest, and verify/reassemble all chunks before
opening SQLite. Do not start a blank database when a file hits a size threshold.
