import fs from 'node:fs';
import path from 'node:path';

export type UpdateStatus = 'success' | 'partial' | 'failed' | 'skipped';
/** Only controlled reason codes reach the public status file, never raw errors. */
export function recordUpdate(status: UpdateStatus, reason: string, affected = 0, tickers: string[] = [], priceAsOf?: string, quarantinedTickers: string[] = []): void {
  const output = process.env.UPDATE_REPORT_PATH;
  if (!output) return;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ status, reason, affected, priceAsOf, quarantinedTickers, tickers: [...new Set(tickers)].sort(), checkedAt: new Date().toISOString() }));
}
