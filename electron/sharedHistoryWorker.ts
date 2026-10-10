import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { mergeSharedHistory } from './sharedHistory';
import { publishToWeb } from './webPublish';

// Import/export and Git operations never run on Electron's window/event loop.
void (async () => {
  let db: Database.Database | undefined;
  try {
    let result: unknown;
    if (workerData.operation === 'publish') result = await publishToWeb(workerData.options);
    else {
      db = new Database(workerData.databasePath);
      db.pragma('foreign_keys = ON');
      result = mergeSharedHistory(db, workerData.source, workerData.revision);
    }
    parentPort!.postMessage({ result });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally { db?.close(); }
})();
