import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  console.log('Navigating to ValueInvesting...');
  await page.goto('https://valueinvesting.io/SMMT/valuation/intrinsic-value', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Let's dump the HTML of elements containing "Intrinsic Value" or "Stock Price"
  const htmls = await page.evaluate(() => {
    const results: string[] = [];
    const elements = Array.from(document.querySelectorAll('div, td'));
    elements.forEach(el => {
      const txt = el.textContent?.trim() || '';
      // Let's check for exact text matches inside children or elements
      if (txt === 'Intrinsic Value' || txt === 'Stock Price' || txt === 'Upside') {
        const parent = el.parentElement;
        if (parent) {
          results.push(`Parent of "${txt}": Tag=${parent.tagName}, Class="${parent.className}", HTML="${parent.outerHTML.slice(0, 300)}"`);
        }
      }
    });
    return results;
  });

  console.log('--- Found HTML structures ---');
  htmls.forEach(h => console.log(h + '\n'));

  await browser.close();
}

main().catch(console.error);
