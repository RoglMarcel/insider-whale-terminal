import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  const url = 'https://www.alphaspread.com/security/nasdaq/smmt/summary';
  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const htmls = await page.evaluate(() => {
    const results: string[] = [];
    const elements = Array.from(document.querySelectorAll('div, span'));
    elements.forEach(el => {
      const txt = el.textContent?.trim() || '';
      if (txt.includes('Intrinsic Value') || txt.includes('Base Case') || txt.includes('Current Price')) {
        if (txt.length < 150) {
          results.push(`${el.tagName} (class="${el.className}"): ${el.outerHTML.slice(0, 300)}`);
        }
      }
    });
    return Array.from(new Set(results));
  });

  console.log('--- AlphaSpread Found structures ---');
  htmls.slice(0, 30).forEach(h => console.log(h + '\n'));

  await browser.close();
}

main().catch(console.error);
