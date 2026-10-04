import { chromium } from 'playwright';

function upside(fairValue?: number, price?: number): number | undefined {
  if (fairValue == null || price == null || price === 0) return undefined;
  return Math.round(((fairValue - price) / price) * 1000) / 10;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  // 1. AlphaSpread
  const alphaUrl = 'https://www.alphaspread.com/security/nasdaq/smmt/summary';
  console.log(`Navigating to AlphaSpread: ${alphaUrl}...`);
  await page.goto(alphaUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const alphaResult = await page.evaluate(() => {
    const ivEl = document.querySelector('.price-ladder__point--iv .price-ladder__value');
    const priceEl = document.querySelector('.price-ladder__point--current .price-ladder__value');
    
    let fairValue: number | null = null;
    let currentPrice: number | null = null;

    if (ivEl) {
      const txt = ivEl.textContent?.trim() || '';
      const parsed = parseFloat(txt.replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(parsed)) fairValue = parsed;
    }
    if (priceEl) {
      const txt = priceEl.textContent?.trim() || '';
      const parsed = parseFloat(txt.replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(parsed)) currentPrice = parsed;
    }

    return { fairValue, currentPrice };
  });

  console.log('AlphaSpread Clean parsed:', alphaResult);
  console.log('AlphaSpread Upside:', upside(alphaResult.fairValue || undefined, alphaResult.currentPrice || undefined));

  // 2. ValueInvesting
  const viUrl = 'https://valueinvesting.io/SMMT/valuation/intrinsic-value';
  console.log(`\nNavigating to ValueInvesting: ${viUrl}...`);
  await page.goto(viUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const viResult = await page.evaluate(() => {
    const squares = Array.from(document.querySelectorAll('.price_square'));
    let fairValue: number | null = null;
    let currentPrice: number | null = null;

    squares.forEach(sq => {
      const normEl = sq.querySelector('.norm');
      const tinyEl = sq.querySelector('.tiny');
      if (normEl && tinyEl) {
        const valText = normEl.textContent?.trim().replace(/\s/g, '').replace(/,/g, '.') || '';
        const val = parseFloat(valText);
        const label = tinyEl.textContent?.trim().toLowerCase() || '';

        if (label.includes('intrinsic value') || label.includes('fair value')) {
          if (Number.isFinite(val)) fairValue = val;
        } else if (label.includes('stock price') || label.includes('current price')) {
          if (Number.isFinite(val) && val > 0) currentPrice = val;
        }
      }
    });

    return { fairValue, currentPrice };
  });

  console.log('ValueInvesting Clean parsed:', viResult);
  console.log('ValueInvesting Upside:', upside(viResult.fairValue || undefined, viResult.currentPrice || undefined));

  await browser.close();
}

main().catch(console.error);
