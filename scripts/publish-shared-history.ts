import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSharedHistory } from '../electron/sharedHistory';
import { packageDesktopSnapshot } from '../electron/desktopSnapshot';

async function main(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwt-shared-'));
  try {
    const file = path.join(temp, 'public.db');
    // Carry the exact rendered view too: a newer local quote cache must not
    // revalue the cloud's book into different numbers on the desktop.
    const publishedPortfolio = JSON.parse(fs.readFileSync(path.resolve('public/data/portfolio.json'), 'utf8'));
    exportSharedHistory(path.resolve('data/insider-tracker.db'), file, publishedPortfolio);
    const directory = path.resolve('public/data/shared-history');
    await packageDesktopSnapshot(file, directory);
    const manifestFile = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, generatedAt: new Date().toISOString() }));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
