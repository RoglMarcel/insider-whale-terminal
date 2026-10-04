/* Live end-to-end check: scrape OpenInsider → merge buys → score → rank. */
import { launchBrowser, createContext } from '../electron/scraper/browser';
import { scrapeOpenInsider } from '../electron/scraper/openinsider';
import { scoreTicker, isBuyTrade } from '../electron/scoring';
import type { RawInsiderTrade, TickerAggregate } from '../src/types';

async function main() {
  console.log('Launching headless Chromium…');
  const browser = await launchBrowser(true);
  const context = await createContext(browser);

  console.log('Scraping OpenInsider (cluster buys + recent purchases)…');
  const trades: RawInsiderTrade[] = await scrapeOpenInsider(context);
  await browser.close();

  console.log(`\nScraped ${trades.length} raw insider rows.`);
  if (trades.length === 0) {
    console.log('❌ No trades parsed — selectors may need updating.');
    process.exit(1);
  }

  // Sample a couple parsed rows to confirm normalization.
  console.log('\nSample parsed trades:');
  for (const t of trades.slice(0, 3)) {
    console.log(`  ${t.ticker.padEnd(6)} ${t.transactionType.padEnd(14)} ${t.insiderName.slice(0, 22).padEnd(22)} ${t.role.slice(0, 24).padEnd(24)} $${Math.round(t.value).toLocaleString('en-US')}`);
  }

  // Merge buys by ticker (mirrors the orchestrator without the DB dependency).
  const buys = trades.filter(isBuyTrade);
  const byTicker = new Map<string, TickerAggregate>();
  for (const t of buys) {
    const agg = byTicker.get(t.ticker) ?? { ticker: t.ticker, companyName: t.companyName, trades: [], options: [], sourceUrls: [] };
    agg.trades.push(t);
    byTicker.set(t.ticker, agg);
  }

  const scored = [...byTicker.values()].map(t => {
    const s = scoreTicker(t);
    if (t.ticker === 'GLOO') {
      console.log('GLOO detailed scored result in verify-scrape:', s);
    }
    return s;
  }).sort((a, b) => {
    const aVal = Number.isNaN(a.score) ? -1 : a.score;
    const bVal = Number.isNaN(b.score) ? -1 : b.score;
    return bVal - aVal;
  });
  console.log(`\nBuys: ${buys.length} · Unique tickers: ${byTicker.size}`);

  console.log('\nTop 8 scored signals:');
  console.log('  TICKER  SCORE  LEVEL   INSIDERS  VOLUME        TOP ROLE');
  for (const s of scored.slice(0, 8)) {
    console.log(
      `  ${s.ticker.padEnd(7)} ${String(s.score).padStart(5)}  ${s.convictionLevel.padEnd(6)}  ${String(s.insiderCount).padStart(8)}  $${Math.round(s.totalDollarVolume).toLocaleString('en-US').padEnd(11)}  ${(s.topInsiderRole || '').slice(0, 28)}`,
    );
  }

  const ok = trades.length > 0 && byTicker.size > 0;
  console.log(`\n${ok ? '✅ LIVE SCRAPE → SCORE PIPELINE WORKS' : '❌ pipeline produced no signals'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('THREW:', e);
  process.exit(1);
});
