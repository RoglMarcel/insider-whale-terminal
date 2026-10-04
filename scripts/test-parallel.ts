import { chromium } from 'playwright';
import { fetchInsiderTrackRecord } from '../electron/scraper/insiderHistory';

async function testOne(context: any, name: string, url: string, role: string) {
  console.log(`[${name}] Starting fetch...`);
  const start = Date.now();
  try {
    const res = await fetchInsiderTrackRecord(context, name, url, role);
    console.log(`[${name}] Finished in ${Date.now() - start}ms. Error: ${res.error || 'none'}`);
    return res;
  } catch (e: any) {
    console.error(`[${name}] Failed:`, e.message);
    return null;
  }
}

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();

  const url1 = 'http://openinsider.com/insider/Zanganeh-Mahkam/1507650';
  const url2 = 'http://openinsider.com/insider/Duggan-Robert-W/184131';

  console.log('Starting parallel fetches...');
  const results = await Promise.all([
    testOne(ctx1, 'Zanganeh Mahkam', url1, 'Co-CEO, 10%'),
    testOne(ctx2, 'Duggan Robert W', url2, 'Co-CEO, 10%')
  ]);

  console.log('All done!');
  await browser.close();
}

main().catch(console.error);
