import { launchBrowser, createContext } from '../electron/scraper/browser';
import { scrapeOpenInsider } from '../electron/scraper/openinsider';
import { scoreTicker } from '../electron/scoring';
import type { TickerAggregate } from '../src/types';

async function main() {
  console.log('Launching headless Chromium…');
  const browser = await launchBrowser(true);
  const context = await createContext(browser);

  console.log('Scraping OpenInsider...');
  const trades = await scrapeOpenInsider(context);
  await browser.close();

  const byTicker = new Map<string, TickerAggregate>();
  for (const t of trades) {
    if (t.transactionType.includes('Purchase') || t.transactionType.includes('BUY')) {
      const agg = byTicker.get(t.ticker) ?? { ticker: t.ticker, companyName: t.companyName, trades: [], options: [], sourceUrls: [] };
      agg.trades.push(t);
      byTicker.set(t.ticker, agg);
    }
  }

  // Debug score for GLOO
  const glooAgg = byTicker.get('GLOO');
  if (glooAgg) {
    console.log('GLOO Aggregate:', JSON.stringify(glooAgg, null, 2));
    
    // Now let's perform the scoring steps manually so we see where NaN is introduced.
    const agg = glooAgg;
    const eligible = agg.trades;
    console.log('Eligible trades count:', eligible.length);
    
    let topWeight = 0;
    let topRole: string | null = null;
    let topName: string | null = null;
    let hasFinance = false;
    let weightedMod = 0;
    let weightTotal = 0;
    
    for (const t of eligible) {
      const { weight } = { weight: 4 }; // mock or call real
      const role = (t.role ?? '').trim();
      const mod = 1.0; // P - Purchase is 1.0
      const w = Math.max(t.value > 0 ? t.value : 1, 1);
      weightedMod += mod * w;
      weightTotal += w;
      console.log(`Trade for ${t.insiderName}: value=${t.value}, weightTotal=${weightTotal}, weightedMod=${weightedMod}`);
    }
    
    const res = scoreTicker(glooAgg);
    console.log('GLOO Scored:', res);
  } else {
    console.log('GLOO not found in scraped tickers. Available tickers:', [...byTicker.keys()].slice(0, 10));
  }
}

main().catch(console.error);
