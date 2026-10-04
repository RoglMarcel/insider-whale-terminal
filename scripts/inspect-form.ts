import { chromium } from 'playwright';

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

  // Dump form inputs
  const inputs = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return 'No form found';
    const elements = Array.from(form.querySelectorAll('input, select'));
    return elements.map(el => {
      const name = el.getAttribute('name') || '';
      const type = el.getAttribute('type') || '';
      const value = el.getAttribute('value') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      return `${el.tagName}: name="${name}" type="${type}" value="${value}" placeholder="${placeholder}"`;
    });
  });

  console.log('--- Search Form Fields ---');
  console.log(inputs);

  await browser.close();
}

main().catch(console.error);
