import { chromium } from 'playwright';
import { extractTable } from '../electron/scraper/util';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  // We search for CIK 1229310
  const url = 'http://openinsider.com/screener.php?o=1229310&v=1&xp=1&xs=1&cnt=1000&page=1';
  console.log(`Navigating to: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const table = await extractTable(page, 'table.tinytable');
    console.log('Headers:', table.headers);
    console.log(`Rows count: ${table.rows.length}`);
    if (table.rows.length > 0) {
      console.log('Row 0:', table.rows[0]);
      if (table.rows.length > 1) console.log('Row 1:', table.rows[1]);
    }
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
