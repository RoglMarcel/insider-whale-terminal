import type { BrowserContext } from 'playwright';
import type { RawInsiderTrade } from '../../src/types';
import { withPage, randomDelay } from './browser';
import { extractFirstTable, extractRowAttribute, canonicalTicker, isValidTicker } from './util';
import { mapInsiderTable } from './insiderMap';

/**
 * Finviz insider trading — role-labeled trades. `tc=1` filters to buys.
 * Finviz changes its table class periodically, so we try several selectors.
 */
const URL = 'https://finviz.com/insidertrading.ashx?tc=1';

const TABLE_SELECTORS = [
  'table.body-table',
  'table.styled-table-new',
  'table.insider-trading-table',
  '#insider-trading table',
  'table.table-light',
];

export async function scrapeFinviz(context: BrowserContext): Promise<RawInsiderTrade[]> {
  return withPage(
    context,
    URL,
    async (page) => {
      await page.waitForSelector('table', { timeout: 15_000 }).catch(() => undefined);
      const table = await extractFirstTable(page, TABLE_SELECTORS);

      // Finviz renders a company logo chip inside the ticker cell whose fallback
      // letter is part of textContent — so the cell reads "PPAL" for PAL, and
      // "BBRK-A" for BRK-A (verified live: <span class="company-ticker"
      // style="--logo-url:…/PAL.svg">). The authoritative symbol is in the row's
      // quote link (`…?t=PAL`).
      //
      // This used to be keyed on the rendered cell TEXT, which broke exactly for
      // the multi-class symbols: `extractTable` builds cell text with
      // `getDeepText` (which injects newlines around DIV/P) while the lookup map
      // was built from `td.textContent` (which does not), so the two spellings
      // diverged and the repair silently missed — BBRK-A, DDGICA, GGLIBA,
      // GGLIBK, LLILAK and FFCNCA all reached the database that way. Reading the
      // link POSITIONALLY, over the same selector and the same row filter, has
      // no key to get wrong.
      const idx = table.headers.findIndex((h) => /ticker|symbol|stock/i.test(h));
      if (idx >= 0 && table.selector) {
        const hrefTickers = await extractRowAttribute(
          page,
          table.selector,
          '[?&]t=([A-Za-z0-9.\-]{1,12})(?:&|$)',
        );
        if (hrefTickers.length === table.rows.length) {
          for (let i = 0; i < table.rows.length; i++) {
            const fromHref = hrefTickers[i];
            if (fromHref && isValidTicker(fromHref)) table.rows[i][idx] = canonicalTicker(fromHref);
          }
        } else {
          console.warn(
            `[finviz] row/link count mismatch (${hrefTickers.length} links vs ${table.rows.length} rows) — ` +
              'skipping the ticker repair rather than mis-assigning symbols',
          );
        }
      }

      // Only keep rows that look like insider data (have an Owner/Relationship header).
      const trades = mapInsiderTable(table, 'finviz', URL);
      return trades;
    },
    { waitUntil: 'domcontentloaded' },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Feature 5 — earnings dates from the Finviz quote snapshot table
// ──────────────────────────────────────────────────────────────────────────

export interface EarningsInfo {
  ticker: string;
  earningsDate?: string;
  earningsTiming?: 'AMC' | 'BMO';
  daysToEarnings?: number;
}

/** Parse Finviz's "Earnings" cell, e.g. "Jun 15 AMC", "May 1/a", "Feb 21 BMO". */
export function parseFinvizEarnings(raw: string): Omit<EarningsInfo, 'ticker'> | null {
  const s = (raw ?? '').trim();
  if (!s || /^-+$/.test(s)) return null;

  let earningsTiming: 'AMC' | 'BMO' | undefined;
  if (/amc|\/a\b/i.test(s)) earningsTiming = 'AMC';
  else if (/bmo|\/b\b/i.test(s)) earningsTiming = 'BMO';

  const dateStr = s.replace(/\/[ab]\b/i, '').replace(/\b(amc|bmo)\b/i, '').trim();
  const year = new Date().getFullYear();
  const parsed = new Date(`${dateStr} ${year}`);
  if (Number.isNaN(parsed.getTime())) return null;

  // Earnings are forward-looking — roll to next year if the date looks past.
  const todayMs = new Date().setHours(0, 0, 0, 0);
  if (parsed.getTime() < todayMs - 5 * 86_400_000) parsed.setFullYear(year + 1);

  // Whole-calendar-day countdown (midnight to midnight): an earnings report
  // later TODAY must read 0, not −1, or it forfeits the timing boost.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const daysToEarnings = Math.round((parsed.getTime() - startOfToday.getTime()) / 86_400_000);
  const y = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return { earningsDate: `${y}-${month}-${d}`, earningsTiming, daysToEarnings };
}

/**
 * Fetch upcoming earnings for a set of tickers from their Finviz quote pages.
 * Bounded (default 25) and politely delayed so it doesn't dominate the scrape.
 */
export async function scrapeFinvizEarnings(
  context: BrowserContext,
  tickers: string[],
  limit = 25,
  maxDurationMs = 80_000,
): Promise<Map<string, EarningsInfo>> {
  const start = Date.now();
  const out = new Map<string, EarningsInfo>();
  for (const ticker of tickers.slice(0, limit)) {
    if (Date.now() - start > maxDurationMs) {
      console.log(`[scraper] scrapeFinvizEarnings timing out early at ${Date.now() - start}ms to preserve ${out.size} results`);
      break;
    }
    try {
      const raw = await withPage(
        context,
        `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`,
        async (page) => {
          await page.waitForSelector('.snapshot-table2', { timeout: 10_000 }).catch(() => undefined);
          return page.evaluate(() => {
            const cells = Array.from(document.querySelectorAll('.snapshot-table2 td')).map(
              (td) => td.textContent?.replace(/\s+/g, ' ').trim() || '',
            );
            for (let i = 0; i < cells.length - 1; i++) {
              if (cells[i].toLowerCase() === 'earnings') return cells[i + 1];
            }
            return '';
          });
        },
        { waitUntil: 'domcontentloaded', timeout: 20_000 },
      );
      const parsed = parseFinvizEarnings(raw);
      if (parsed) out.set(ticker, { ticker, ...parsed });
    } catch {
      /* skip this ticker */
    }
    await randomDelay(700, 1400);
  }
  return out;
}
