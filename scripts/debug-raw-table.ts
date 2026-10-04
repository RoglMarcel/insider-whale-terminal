import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const url = 'http://openinsider.com/insider/Zanganeh-Mahkam/1507650';
  const page = await context.newPage();
  
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const tableHtml = await page.evaluate(() => {
    const table = document.querySelector('table.tinytable');
    if (!table) return { thead: 'Table not found', firstRow: 'Table not found' };
    const thead = table.querySelector('thead')?.outerHTML || 'No thead';
    const firstRow = table.querySelector('tbody tr')?.outerHTML || 'No rows';
    return { thead, firstRow };
  });

  console.log('--- raw thead ---');
  console.log(tableHtml.thead);
  console.log('--- raw first row ---');
  console.log(tableHtml.firstRow);

  await browser.close();
}

main().catch(console.error);
