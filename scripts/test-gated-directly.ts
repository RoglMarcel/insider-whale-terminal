import { launchBrowser, createContext } from '../electron/scraper/browser';
import { scrapeFinviz } from '../electron/scraper/finviz';
import { scrapeMarketBeat } from '../electron/scraper/marketbeat';
import { scrapeBarchart } from '../electron/scraper/barchart';
import { scrapeOptionStrat } from '../electron/scraper/optionstrat';
import { scrapeInsiderFinance } from '../electron/scraper/insiderfinance';
import { app } from 'electron';

app.whenReady().then(async () => {
  console.log('Launching headless browser...');
  const browser = await launchBrowser(true);
  const context = await createContext(browser);

  const testScraper = async (name: string, fn: (ctx: any) => Promise<any>) => {
    console.log(`\n--- Testing Scraper: ${name} ---`);
    const start = Date.now();
    try {
      // Run with a 30s timeout on each scraper test
      const timedOut = Symbol('timeout');
      const result = await Promise.race([
        fn(context),
        new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 30000))
      ]);
      
      if (result === timedOut) {
        console.log(`❌ ${name} TIMED OUT after 30s!`);
      } else {
        console.log(`✅ ${name} finished in ${((Date.now() - start)/1000).toFixed(1)}s. Found ${result.length} rows.`);
        if (result.length > 0) {
          console.log(`Sample row:`, JSON.stringify(result[0]).slice(0, 150));
        }
      }
    } catch (err) {
      console.log(`❌ ${name} failed with error:`, err instanceof Error ? err.message : String(err));
    }
  };

  await testScraper('finviz', scrapeFinviz);
  await testScraper('marketbeat', scrapeMarketBeat);
  await testScraper('barchart', scrapeBarchart);
  await testScraper('optionstrat', scrapeOptionStrat);
  await testScraper('insiderfinance', scrapeInsiderFinance);

  console.log('\nAll tests completed.');
  await browser.close();
  app.exit(0);
});
