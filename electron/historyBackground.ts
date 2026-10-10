import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotDatabase } from './database';
import type { PublishOptions, WebPublishResult } from './webPublish';

export function runHistoryWorker<T>(workerData: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'sharedHistoryWorker.js'), { workerData });
    let reply: { result?: T; error?: string } | undefined;
    worker.once('message', message => { reply = message; });
    worker.once('error', reject);
    // Cleanup is safe only after SQLite closes and the worker exits.
    worker.once('exit', code => {
      if (code !== 0 || !reply || reply.error || !('result' in reply)) reject(new Error(reply?.error || `History worker exited (${code})`));
      else resolve(reply.result as T);
    });
  });
}

let publishing: Promise<WebPublishResult> | undefined;
export function publishHistoryInBackground(options: PublishOptions): Promise<WebPublishResult> {
  if (publishing) return publishing;
  publishing = (async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iwt-background-publish-'));
    try {
      const snapshot = path.join(directory, 'snapshot.db');
      await snapshotDatabase(snapshot); // Asynchronous, WAL-consistent snapshot.
      return await runHistoryWorker<WebPublishResult>({ operation: 'publish', options: { ...options, sourceDbPathForTest: snapshot } });
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
  })().finally(() => { publishing = undefined; });
  return publishing;
}
