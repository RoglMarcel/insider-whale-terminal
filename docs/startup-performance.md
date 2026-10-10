# Startup responsiveness

The dashboard mounted every signal card and fetched full analyses automatically when a summary was missing. On desktop the summary file is not bundled, so opening the dashboard queued live fundamental-data requests. Startup also called synchronous Git clone/push operations and imported historical SQLite data on Electron's main thread.

The overview now mounts 24 cards initially and offers more in batches of 24. It uses recorded valuations or one shared web summary; only an opened detail requests full analysis. Parallel web startup consumers share JSON downloads. The latest-signal query restricts its window ranking to the active date range instead of ranking the entire archive.

Desktop import and publication run in a packaged worker. Publication starts from an asynchronous WAL-consistent snapshot. Import retains the existing atomic merge, conflict rules and recovery revision. Git subprocesses use asynchronous execution and hidden windows. The startup tutorial and intro video no longer render or make version-check requests.

Validation: typecheck; production desktop and web builds; 616 unit tests; native bidirectional sync/rollback/checksum tests with an event-loop heartbeat; background publication fixture with external pushes disabled; local Git publication integration. A Chromium smoke test using existing published data rendered the first 24 cards in 501 ms, made no full-analysis requests from the overview, downloaded signals once, and recorded no tasks above 50 ms. Loading the remaining filtered cards and opening a detail worked (one full-analysis request). These timings describe the isolated test machine, not all user devices.
