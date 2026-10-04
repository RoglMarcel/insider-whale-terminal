import { initDatabase } from '../electron/database';
import { runScrape } from '../electron/scraper';
import { getSettings } from '../electron/database';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

app.whenReady().then(async () => {
  const prodDbPath = 'C:/Users/8marc/AppData/Roaming/insider-whale-terminal/insider-tracker.db';
  const testDbPath = path.join(__dirname, '..', 'tmp', 'test-scrape.db');
  
  console.log('Copying production DB to test DB...');
  fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
  fs.copyFileSync(prodDbPath, testDbPath);
  
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
  // Run headlessly
  settings.headless = true;
  
  console.log('Starting full scrape...');
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
