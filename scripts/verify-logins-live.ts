import { app } from 'electron';
import path from 'node:path';
app.setPath('userData', path.join(app.getPath('appData'), 'insider-whale-terminal'));

import { chromium } from 'playwright';
import { authStatus, loadMergedStorageState } from '../electron/auth';

app.whenReady().then(async () => {
  console.log('App ready. Checking logins...');
  const status = authStatus();
  console.log('Stored Auth Status:', JSON.stringify(status, null, 2));

  const state = loadMergedStorageState();
  if (!state) {
    console.log('No logged in sessions found!');
    app.quit();
    return;
  }

  console.log('Launching browser with session state...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: state as any,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // 1. Check ValueInvesting.io
  if (status.valueinvesting?.loggedIn) {
    console.log('\n--- Checking ValueInvesting.io ---');
    try {
      await page.goto('https://valueinvesting.io/', { waitUntil: 'networkidle', timeout: 30000 });
      const isLoggedInValueInvesting = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.toLowerCase().includes('log out') || text.toLowerCase().includes('sign out') || !text.toLowerCase().includes('log in');
      });
      console.log('ValueInvesting.io logged in state detected:', isLoggedInValueInvesting);
      console.log('Current URL:', page.url());
    } catch (e: any) {
      console.error('ValueInvesting check failed:', e.message);
    }
  }

  // 2. Check OptionStrat
  if (status.optionstrat?.loggedIn) {
    console.log('\n--- Checking OptionStrat ---');
    try {
      await page.goto('https://optionstrat.com/flow', { waitUntil: 'networkidle', timeout: 30000 });
      const isLoggedInOptionStrat = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.toLowerCase().includes('sign out') || text.toLowerCase().includes('log out') || !text.toLowerCase().includes('log in');
      });
      console.log('OptionStrat logged in state detected:', isLoggedInOptionStrat);
      console.log('Current URL:', page.url());
    } catch (e: any) {
      console.error('OptionStrat check failed:', e.message);
    }
  }

  // 3. Check AlphaSpread
  if (status.alphaspread?.loggedIn) {
    console.log('\n--- Checking AlphaSpread ---');
    try {
      await page.goto('https://www.alphaspread.com/', { waitUntil: 'networkidle', timeout: 30000 });
      const isLoggedInAlphaSpread = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.toLowerCase().includes('sign out') || text.toLowerCase().includes('log out') || !text.toLowerCase().includes('sign in');
      });
      console.log('AlphaSpread logged in state detected:', isLoggedInAlphaSpread);
      console.log('Current URL:', page.url());
    } catch (e: any) {
      console.error('AlphaSpread check failed:', e.message);
    }
  }

  console.log('\nVerification complete. Closing browser...');
  await browser.close();
  app.quit();
});
