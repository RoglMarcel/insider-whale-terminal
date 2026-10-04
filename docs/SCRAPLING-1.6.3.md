# Shared Scrapling collection in 1.6.3

Windows desktop now ships a self-contained Scrapling 0.4.15 worker built with PyInstaller. Python, parser dependencies, curl/TLS libraries, certificates and required package data are bundled outside app.asar, under resources/scrapling-runtime. Third-party license notices are included. Users do not install Python or pip, and the app does not download an executable at first scrape.

The desktop resolves that worker from the installed resource directory, automatically enables it, and launches it with hidden windows. Its location does not depend on the current working directory or PATH. GitHub uses the same Python worker source and pinned Scrapling version, installed in its runner. Source deployments retain explicit Python configuration and a development opt-out.

Both paths use Scrapling for OpenInsider, SECForm4, Insider Monitor, StockAnalysis/Finviz fundamentals, StockAnalysis share/short-interest stats, and external fair-value references. Existing transaction/financial parsers remain shared. Insider Monitor uses its current HTTPS URL. Pure quote APIs, SEC feeds and browser/session-dependent sources keep their appropriate API/Playwright transports; using Scrapling does not imply access to blocked or login-gated sources.

Subprocesses are bounded by timeout, output size and caller cancellation; no shell execution, proxy or captcha handling is used. Only allowlisted public hosts are fetched, with automatic redirects disabled. Failed requests carry structured HTTP status and remain failures rather than fabricated data.

Windows CI builds and health-checks the worker before creating the installer. The local packaging preflight verifies the worker's version and source hash, so outdated or missing runtime files cannot silently ship. Every runtime change rebuilds the bundled worker. The installer and auto-updater ship the entire runtime folder together.
