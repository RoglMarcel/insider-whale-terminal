import { chromium } from 'playwright';
import { fetchInsiderTrackRecord } from '../electron/scraper/insiderHistory';

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const url = 'http://openinsider.com/insider/Zanganeh-Mahkam/1507650';
  console.log(`Fetching track record from: ${url}...`);
  
  try {
    const result = await fetchInsiderTrackRecord(context, 'Zanganeh Mahkam', url, 'Co-CEO, 10%');
    console.log('Scrape Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('Error during scrape:', e);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
