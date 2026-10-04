import { chromium } from 'playwright';
import { extractTable } from '../electron/scraper/util';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  console.log('Navigating to openinsider.com...');
  await page.goto('http://openinsider.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Let's fill the input named "o" with "Bortz Jon E"
  console.log('Entering "Bortz Jon E" in the owner search input...');
  await page.fill('input[name="o"]', 'Bortz Jon E');

  // Submit the form
  console.log('Submitting the form...');
  await page.click('input[type="submit"][value="Go"], input[type="submit"][value="Search"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  console.log('Final URL:', page.url());
  const table = await extractTable(page, 'table.tinytable');
  console.log('Headers:', table.headers);
  console.log('Rows count:', table.rows.length);
  if (table.rows.length > 0) {
    console.log('Row 0:', table.rows[0]);
  }

  await browser.close();
}

main().catch(console.error);
