/**
 * Exercise the Capitol Trades PLAYWRIGHT layer end-to-end (the one layer that
 * verify-congress.ts can't test, since it needs a real browser context).
 *
 * Run:
 *   npx esbuild scripts/test-politician.ts --bundle --platform=node --format=cjs \
 *     --external:playwright --outfile=tmp/test-politician.cjs && node tmp/test-politician.cjs
 */
import { launchBrowser, createContext, installChromium } from '../electron/scraper/browser';
import { scrapeCapitolTradesPlaywright } from '../electron/scraper/capitoltrades';
import type { Browser } from 'playwright';
import type { PoliticianTrade } from '../src/types';

async function main() {
  console.log('=== Capitol Trades — Playwright layer ===');
  console.log('Launching headless Chromium…');

  let browser: Browser | null = null;
  const start = Date.now();
  try {
    try {
      browser = await launchBrowser(true);
    } catch (err: any) {
      const missingBrowser =
        typeof err?.message === 'string' &&
        (err.message.includes("Executable doesn't exist") ||
          err.message.includes('Please run the following command to download new browsers'));
      if (!missingBrowser) throw err;
      console.log('Chromium binary missing — installing (one-time)…');
      await installChromium();
      browser = await launchBrowser(true);
    }

    const context = await createContext(browser);
    const trades: PoliticianTrade[] = await scrapeCapitolTradesPlaywright(context, 90);

    console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    console.log(`Trades returned: ${trades.length}`);
    if (trades.length > 0) {
      console.log('Sample (first 5):');
      trades.slice(0, 5).forEach((t) => {
        const tag = `${(t.party || '?')[0]}·${t.chamber}`;
        console.log(
          `  ${t.politician} (${tag}) | ${t.ticker} | ${t.transactionType.toUpperCase()} | ` +
            `$${t.amountMidpoint.toLocaleString('en-US')} | ${t.tradeDate} | disclosed in ${t.daysToDisclose}d`,
        );
      });
    } else {
      console.log('No trades parsed — the layer loaded but found nothing (check logs above).');
    }
  } catch (err) {
    // scrapeCapitolTradesPlaywright throws on hard failure (checkpoint / no rows);
    // surface it rather than pretending the layer is healthy.
    console.error('Playwright layer error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

main();
