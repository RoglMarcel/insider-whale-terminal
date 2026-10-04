import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  const url = 'http://openinsider.com/screener.php?insider=Bortz+Jon+E';
  console.log(`Navigating to: ${url}`);
  
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log('Response status:', resp?.status());
    console.log('Page title:', await page.title());
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    console.log('Page text preview (first 500 chars):');
    console.log(bodyText.slice(0, 500));
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
