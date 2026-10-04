import { chromium } from 'playwright';
import { extractTable } from '../electron/scraper/util';

async function testInsider(context: any, url: string, name: string) {
  const page = await context.newPage();
  try {
    console.log(`Navigating to ${name}: ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const table = await extractTable(page, 'table.tinytable');
    console.log(`  Headers:`, table.headers);
    console.log(`  Rows: ${table.rows.length}`);
    if (table.rows.length > 0) {
      console.log(`  Row 0:`, table.rows[0]);
      if (table.rows.length > 1) console.log(`  Row 1:`, table.rows[1]);
    }
  } catch (e) {
    console.error(`  Error:`, e);
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  // Test 1: PEB (Bortz Jon E)
  await testInsider(context, 'http://openinsider.com/insider/Bortz-Jon-E/1229310', 'Bortz Jon E');

  // Test 2: BRC (Nargolwala Vineet A)
  await testInsider(context, 'http://openinsider.com/insider/Nargolwala-Vineet-A/1807649', 'Nargolwala Vineet A');

  // Test 3: COSM (Siokas Grigorios)
  await testInsider(context, 'http://openinsider.com/insider/Siokas-Grigorios/1660125', 'Siokas Grigorios');

  await browser.close();
}

main().catch(console.error);
