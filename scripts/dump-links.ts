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

  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => `${a.textContent?.trim()} -> ${a.getAttribute('href')}`);
  });

  console.log('--- All Links ---');
  links.forEach(l => console.log(l));

  await browser.close();
}

main().catch(console.error);
