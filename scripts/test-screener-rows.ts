import { chromium } from 'playwright';
import { extractTable } from '../electron/scraper/util';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  const url = 'http://openinsider.com/screener?s=&o=1229310&pl=&ph=&ll=&lh=&fd=0&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&vl=&vh=&ocl=&och=&sicl=&sich=&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=100&page=';
  console.log(`Navigating to: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const table = await extractTable(page, 'table.tinytable');
    console.log('Total rows:', table.rows.length);
    table.rows.forEach((r, i) => {
      const p1d = r[12];
      const p1w = r[13];
      const p1m = r[14];
      const p6m = r[15];
      // Only print if there's any non-empty performance data
      if (p1d || p1w || p1m || p6m) {
        console.log(`Row ${i} (${r[2]}): price=${r[7]} value=${r[11]} 1d=${p1d} 1w=${p1w} 1m=${p1m} 6m=${p6m}`);
      }
    });
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
