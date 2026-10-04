import { initDatabase } from '../electron/database';
import { runScrape } from '../electron/scraper';
import { getSettings } from '../electron/database';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

app.whenReady().then(async () => {
  const prodUserData = 'C:/Users/8marc/AppData/Roaming/insider-whale-terminal';
  const prodDbPath = path.join(prodUserData, 'insider-tracker.db');
  
  const testUserData = app.getPath('userData');
  const testDbPath = path.join(testUserData, 'insider-tracker-test.db');
  
  console.log('Test UserData Path:', testUserData);
  
  console.log('Copying production DB to test DB...');
  fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
  fs.copyFileSync(prodDbPath, testDbPath);
  
  console.log('Copying production sessions to test sessions...');
  const prodSessionsDir = path.join(prodUserData, 'sessions');
  const testSessionsDir = path.join(testUserData, 'sessions');
  fs.mkdirSync(testSessionsDir, { recursive: true });
  if (fs.existsSync(prodSessionsDir)) {
    const files = fs.readdirSync(prodSessionsDir);
    for (const file of files) {
      fs.copyFileSync(path.join(prodSessionsDir, file), path.join(testSessionsDir, file));
      console.log(`Copied session: ${file}`);
    }
  }
  
  console.log('Initializing database at:', testDbPath);
  initDatabase(testDbPath);
  
  const settings = getSettings();
  console.log('Scraper settings:', settings);
  
  // Set all sources to true for testing
  settings.sources = {
    edgar: true,
    openinsider: true,
    finviz: true,
    secform4: true,
    marketbeat: true,
    insidermonitor: true,
    quiverquant: true,
      ceowatcher: true,
    barchart: true,
    optionstrat: true,
    insiderfinance: true,
    marketbeatoptions: true
  };
  settings.headless = true;
  
  console.log('Starting full scrape with sessions...');
  try {
    const result = await runScrape({
      settings,
      vix: 15.0,
      onStatus: (status) => {
        console.log(`[STATUS] Phase: ${status.phase} | Current: ${status.currentSource} | Completed: ${status.completedSources.join(', ')}`);
      }
    });
    console.log('Scrape finished with status:', result.status);
    console.log('Signals found:', result.signals?.length);
    console.log('Errors:', result.errors);
  } catch (err) {
    console.error('Scrape caught crash error:', err);
  }
  
  app.exit(0);
});
