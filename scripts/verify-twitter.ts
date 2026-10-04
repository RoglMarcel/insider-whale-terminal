import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

app.setPath('userData', path.join(app.getPath('appData'), 'insider-whale-terminal'));

import { chromium } from 'playwright';
import { authStatus, loadMergedStorageState } from '../electron/auth';

app.whenReady().then(async () => {
  console.log('App ready. Checking Twitter login status...');
  const status = authStatus();
  console.log('Stored Auth Status:', JSON.stringify(status, null, 2));

  if (!status.twitter?.loggedIn) {
    console.log('Twitter session is not logged in! Please check Settings -> Platform Logins.');
    app.quit();
    return;
  }

  const state = loadMergedStorageState(['twitter']);
  console.log('Launching browser with Twitter session state...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: state as any,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to https://x.com/WhaleInsider ...');
    await page.goto('https://x.com/WhaleInsider', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait a bit to let any client-side content render
    await page.waitForTimeout(5000);

    // Save a screenshot to the scratch folder for visual diagnostics
    const screenshotPath = path.join(__dirname, '../tmp/twitter_diagnostics.png');
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
    console.log(`Saved diagnostics screenshot to ${screenshotPath}`);

    // Print current URL to see if we got redirected (e.g. to login or error page)
    console.log('Current URL after navigation:', page.url());

    // Check if we see the tweets selector
    const tweetCount = await page.evaluate(() => document.querySelectorAll('[data-testid="tweet"]').length);
    console.log(`Found ${tweetCount} elements with [data-testid="tweet"]`);

    if (tweetCount === 0) {
      console.log('No tweets found. Let us inspect what content is on the page...');
      const bodyText = await page.evaluate(() => document.body.innerText || '');
      console.log('Page text preview (first 1000 chars):');
      console.log(bodyText.slice(0, 1000));
    } else {
      const tweets = await page.evaluate(() => {
        const tweetElements = document.querySelectorAll('[data-testid="tweet"]');
        const results: { text: string; timestamp: string; href: string }[] = [];
        tweetElements.forEach((el) => {
          const textEl = el.querySelector('[data-testid="tweetText"]');
          const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement;
          const timeEl = el.querySelector('time') as HTMLTimeElement;
          results.push({
            text: textEl ? textEl.textContent || '' : '',
            timestamp: timeEl ? timeEl.getAttribute('datetime') || '' : '',
            href: linkEl ? linkEl.getAttribute('href') || '' : ''
          });
        });
        return results;
      });
      console.log('--- Scraped Tweets ---');
      console.log(JSON.stringify(tweets, null, 2));
    }
  } catch (err: any) {
    console.error('Error during scrape:', err.message);
  } finally {
    await browser.close();
    app.quit();
  }
});
