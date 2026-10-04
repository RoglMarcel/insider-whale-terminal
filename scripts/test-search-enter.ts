import { chromium } from 'playwright';
import { extractTable } from '../electron/scraper/util';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  console.log('Navigating to openinsider.com/screener.php...');
  await page.goto('http://openinsider.com/screener.php', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Type in the owner input and press Enter
  console.log('Filling owner input with "1229310" and pressing Enter...');
  const ownerInput = page.locator('input[name="o"]');
  await ownerInput.fill('1229310');
  await ownerInput.press('Enter');

  console.log('Waiting for navigation...');
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
