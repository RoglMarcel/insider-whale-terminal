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

  const text = await page.evaluate(() => document.body.innerText || '');
  console.log('--- Page text preview (first 1500 chars) ---');
  console.log(text.slice(0, 1500));
  console.log('--------------------------------------------');

  // Let's print some likely elements or boxes
  const boxes = await page.evaluate(() => {
    const results: string[] = [];
    // Find divs or spans containing "Intrinsic Value" or "Stock Price" or "Upside"
    const elements = Array.from(document.querySelectorAll('div, span, td, th'));
    elements.forEach(el => {
      const txt = el.textContent?.trim() || '';
      if (txt.includes('Intrinsic Value') || txt.includes('Peter Lynch Fair Value') || txt.includes('Upside')) {
        if (txt.length < 200) {
          results.push(`${el.tagName}: ${txt}`);
        }
      }
    });
    return Array.from(new Set(results));
  });

  console.log('--- Found Elements ---');
  boxes.slice(0, 30).forEach(b => console.log(b));

  await browser.close();
}

main().catch(console.error);
