import type { BrowserContext } from 'playwright';
import type { OptionsActivity } from '../../src/types';
import { withPage, randomDelay } from './browser';
import { extractFirstTable, colIndex, cell, parseShares, isValidTicker, canonicalTicker } from './util';

/**
 * MarketBeat unusual options VOLUME (calls + puts pages). Public, no login —
 * unlike the three contract-level options sources, which are login-gated or
 * bot-hostile. These pages report volume anomalies per ticker (today's option
 * volume vs the average), not individual prints, so rows carry volume and
 * direction but NO premium: notional stays 0, meaning they can never gate a
 * whale signal on their own (that requires a ≥$250k print) — they only add
 * directional options context to aggregates that already qualify.
 */
const PAGES: ReadonlyArray<{ url: string; type: 'call' | 'put' }> = [
  { url: 'https://www.marketbeat.com/market-data/unusual-call-options-volume/', type: 'call' },
  { url: 'https://www.marketbeat.com/market-data/unusual-put-options-volume/', type: 'put' },
];

const TABLE_SELECTORS = ['table.scroll-table', '#cphPrimaryContent_pnlContent table', 'table'];

export async function scrapeMarketBeatOptions(context: BrowserContext): Promise<OptionsActivity[]> {
  const all: OptionsActivity[] = [];
  for (const pageDef of PAGES) {
    const rows = await withPage(
      context,
      pageDef.url,
      async (page) => {
        await page.waitForSelector('table', { timeout: 15_000 }).catch(() => undefined);
        const table = await extractFirstTable(page, [...TABLE_SELECTORS]);
        const idx = {
          company: colIndex(table.headers, ['company', 'ticker', 'symbol']),
          volume: colIndex(table.headers, ['call options volume', 'put options volume', 'options volume']),
          avgVolume: colIndex(table.headers, ['average options volume']),
        };

        const out: OptionsActivity[] = [];
        for (const row of table.rows) {
          // Company cell renders ticker + name as separate lines ("FROG\nJFrog").
          const parts = cell(row, idx.company)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          const rawTicker = parts[0] ?? '';
          if (!isValidTicker(rawTicker)) continue;
          const ticker = canonicalTicker(rawTicker);
          if (!ticker) continue;

          const volume = parseShares(cell(row, idx.volume));
          if (!volume) continue;
          // Require the volume to actually be UNUSUAL (≥2× the average) so a
          // quiet ticker that merely appears on the page doesn't add noise.
          const avgVolume = parseShares(cell(row, idx.avgVolume));
          if (avgVolume > 0 && volume < avgVolume * 2) continue;

          out.push({
            ticker,
            type: pageDef.type,
            sentiment: pageDef.type === 'put' ? 'bearish' : 'bullish',
            // No premium on a volume-anomaly page — 0 keeps the row honest
            // (context only; cannot gate a whale or masquerade as a print).
            notional: 0,
            volume,
            source: 'marketbeatoptions',
            sourceUrl: pageDef.url,
          });
        }
        return out;
      },
      { waitUntil: 'domcontentloaded' },
    );
    all.push(...rows);
    await randomDelay();
  }
  return all;
}
