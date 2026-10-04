import { chromium } from 'playwright';
import { extractTable } from '../electron/scraper/util';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const url = 'http://openinsider.com/insider/Bortz-Jon-E/1229310';
  const page = await context.newPage();
  
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const table = await extractTable(page, 'table.tinytable');
  console.log('Headers:', table.headers);
  console.log('Total rows:', table.rows.length);
  
  table.rows.forEach((r, i) => {
    // If the row has any non-empty performance cells, print them
    const p1d = r[12];
    const p1w = r[13];
    const p1m = r[14];
    const p6m = r[15];
    console.log(`Row ${i} (${r[2]}): price=${r[7]} value=${r[11]} 1d=${p1d} 1w=${p1w} 1m=${p1m} 6m=${p6m}`);
  });

  await browser.close();
}

main().catch(console.error);
