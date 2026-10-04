import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  await page.goto('http://openinsider.com/screener.php', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, select')).map(el => {
      const name = el.getAttribute('name') || '';
      const id = el.getAttribute('id') || '';
      const type = el.getAttribute('type') || '';
      const value = el.getAttribute('value') || '';
      return `${el.tagName}: name="${name}" id="${id}" type="${type}" value="${value}"`;
    });
  });

  console.log('--- Screener inputs ---');
  inputs.forEach(i => console.log(i));

  await browser.close();
}

main().catch(console.error);
