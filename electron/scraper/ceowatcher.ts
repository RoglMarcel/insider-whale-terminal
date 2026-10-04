import type { BrowserContext } from 'playwright';
import type { RawInsiderTrade } from '../../src/types';
import { withPage, randomDelay } from './browser';
import { parseMoney, parseShares, cleanText, sanitizeTradeAmounts, isValidTicker, canonicalTicker } from './util';

/**
 * CEOWatcher (instagram.com/ceowatcher) — a curated insider-buy feed. Unlike
 * every other source here it is editorial: it only posts buys its author
 * considers notable ("insiders with a good track record"), which is the reason
 * to carry it at all. The dollar figures themselves are never better than
 * OpenInsider/EDGAR, so this source exists to SURFACE names those windows
 * missed, not to price them (see UNDATED_TRADE_SOURCES in scraper/index.ts).
 *
 * ONLY THE CAPTION IS READ. The post media (image / reel video) is never
 * fetched or analysed — the caption carries the whole payload, and Instagram
 * exposes it verbatim in the `og:description` meta tag.
 *
 * A browser is required: instagram.com serves a client-rendered shell, and a
 * plain fetch of a post URL returns ~616KB of JS with no og:description in it
 * (verified live). The profile grid hides post CONTENT behind a login wall, but
 * still renders the post permalinks, and each individual post page exposes its
 * full caption without a session — so no login is needed.
 */

const PROFILE_URL = 'https://www.instagram.com/ceowatcher/';
/** Posts fetched per run. Each is one page load, and the per-source budget is 75s. */
const MAX_POSTS = 10;

/** `74 likes, 1 comments - ceowatcher on August 20, 2026: "<caption>". ` */
function unwrapOgCaption(og: string): string {
  const m = og.match(/:\s*"([\s\S]*)"\s*\.?\s*$/);
  return (m ? m[1] : og).trim();
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Post date from the og:description prefix (`... - ceowatcher on August 20,
 * 2026: "`). This is the PRIMARY source rather than the `<time datetime>`
 * element: og:description is present the moment the meta tag hydrates, whereas
 * `<time>` renders later — reading it too early silently fell back to "today"
 * and stamped every post with the scrape date instead of its own.
 * Month names are mapped explicitly rather than via Date.parse, whose handling
 * of `"August 20, 2026"` is implementation-defined.
 */
function parseOgPostDate(og: string): string | null {
  const m = og.match(/\bon\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*:/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || !day || day > 31 || !year) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Digest format — one post listing several trades, each as a detail line:
 *   `SHANKS EARL C (Director) at Gaming & Leisure Properties, Inc. ($GLPI)
 *    purchased 10,000 shares at $42.24 ($422.40K total), which increased ...`
 * This is the rich variant: real insider name, share count and price. The
 * numbered header line above each detail line carries no amounts, so requiring
 * "<n> shares at $<price>" skips it without extra bookkeeping.
 */
const DIGEST_RE =
  /([A-Z][A-Za-z.’'\- ]+?)\s*\(([^)]{2,60})\)\s+at\s+(.+?)\s*\(\$?([A-Z][A-Z.\-]{0,5})\)\s+(purchased|bought|sold)\s+([\d,]+)\s+shares?\s+at\s+\$([\d,.]+)\s*\(\s*\$([\d,.]+\s*[KMB]?)\s*total\s*\)/gi;

/**
 * Single-alert format — one post, one trade, plus a written thesis:
 *   `🚨 INSIDER TRADE ALERT at Cardinal Infrastructure Group Inc. (CDNL)
 *    The Chief Financial Officer just purchased $255.71K of the stock.`
 * No insider name, no share count and no price are given — only a role and a
 * rounded dollar total.
 */
const ALERT_HEADER_RE = /INSIDER TRADE ALERT\s+(?:at|in)\s+(.+?)\s*\(\$?([A-Z][A-Z.\-]{0,5})\)/i;
const ALERT_BODY_RE =
  /\bThe\s+(.+?)\s+just\s+(purchased|bought|sold|acquired)\s+\$?([\d,.]+\s*[KMB]?)\s+(?:worth\s+)?of\s+(?:the\s+)?(?:stock|shares)/i;

function buildTrade(input: {
  ticker: string;
  companyName?: string;
  insiderName: string;
  role: string;
  verb: string;
  shares: number;
  price?: number;
  value: number;
  postDate: string;
  postUrl: string;
}): RawInsiderTrade | null {
  if (!isValidTicker(input.ticker)) return null;
  const ticker = canonicalTicker(input.ticker);
  if (!ticker) return null;
  const sane = sanitizeTradeAmounts(input.shares, input.price, input.value);
  if (!sane) return null;
  const sold = /sold|sale|dispos/i.test(input.verb);
  return {
    ticker,
    companyName: input.companyName ? cleanText(input.companyName) : undefined,
    insiderName: cleanText(input.insiderName) || 'Unknown',
    role: cleanText(input.role),
    // Normalized to the SEC-style strings classifyTransaction expects, so a
    // "sold" post is scored as an excluded disposal, not as a purchase.
    transactionType: sold ? 'S - Sale' : 'P - Purchase',
    // Publication date is not evidence of the execution day.
    tradeDate: '',
    dateStatus: 'unknown',
    transactionId: `${input.postUrl}:${ticker}:${cleanText(input.insiderName)}`,
    shares: sane.shares,
    price: sane.price,
    value: sane.value,
    source: 'ceowatcher',
    sourceUrl: input.postUrl,
  };
}

/**
 * Parse one caption into trades. Pure and exported so both live formats can be
 * regression-tested without a browser.
 */
export function parseCeoWatcherCaption(
  captionRaw: string,
  postDate: string,
  postUrl: string,
): RawInsiderTrade[] {
  const caption = (captionRaw ?? '').replace(/\r/g, '');
  if (!caption.trim()) return [];
  const out: RawInsiderTrade[] = [];

  // Digest first — a post matching it never carries a single-alert header.
  DIGEST_RE.lastIndex = 0;
  for (let m = DIGEST_RE.exec(caption); m; m = DIGEST_RE.exec(caption)) {
    const [, name, role, company, ticker, verb, sharesRaw, priceRaw, totalRaw] = m;
    const shares = parseShares(sharesRaw);
    const price = parseMoney(priceRaw) || undefined;
    // Prefer the stated total; fall back to shares × price when it is missing or
    // unparseable, so a formatting change in one field doesn't drop the row.
    const value = parseMoney(totalRaw) || (shares && price ? shares * price : 0);
    const t = buildTrade({
      ticker,
      companyName: company,
      insiderName: name,
      role,
      verb,
      shares,
      price,
      value,
      postDate,
      postUrl,
    });
    if (t) out.push(t);
  }
  if (out.length) return out;

  const header = caption.match(ALERT_HEADER_RE);
  const body = caption.match(ALERT_BODY_RE);
  if (header && body) {
    const t = buildTrade({
      ticker: header[2],
      companyName: header[1],
      // This format identifies the insider only by title.
      insiderName: 'Unknown',
      role: body[1],
      verb: body[2],
      shares: 0,
      price: undefined,
      value: parseMoney(body[3]),
      postDate,
      postUrl,
    });
    if (t) out.push(t);
  }
  return out;
}

/** Collect recent post permalinks from the profile grid. */
async function collectPostUrls(context: BrowserContext): Promise<string[]> {
  return withPage(
    context,
    PROFILE_URL,
    async (page) => {
      await page
        .waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 20_000 })
        .catch(() => undefined);
      const hrefs = await page.evaluate(() => {
        const seen: string[] = [];
        document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
          if (m && !seen.includes(m[0])) seen.push(m[0]);
        });
        return seen;
      });
      if (!hrefs.length) {
        throw new Error(
          'CEOWatcher profile rendered no post links — layout changed or the page was blocked',
        );
      }
      return hrefs.slice(0, MAX_POSTS).map((h) => `https://www.instagram.com${h}/`);
    },
    { waitUntil: 'domcontentloaded', timeout: 45_000 },
  );
}

/** Read one post's caption + post date. Null when the post exposes neither. */
async function readPost(
  context: BrowserContext,
  url: string,
): Promise<{ caption: string; date: string } | null> {
  return withPage(
    context,
    url,
    async (page) => {
      // og:description is injected after hydration — poll for it rather than
      // sleeping a fixed amount on every post.
      await page
        .waitForFunction(
          () => !!document.querySelector('meta[property="og:description"]')?.getAttribute('content'),
          undefined,
          { timeout: 15_000 },
        )
        .catch(() => undefined);
      const data = await page.evaluate(() => ({
        og: document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '',
        time: document.querySelector('time')?.getAttribute('datetime') ?? '',
      }));
      if (!data.og) return null;
      // og prefix first, then the <time> element, then today as a last resort.
      const fromOg = parseOgPostDate(data.og);
      const fromTime =
        data.time && !Number.isNaN(Date.parse(data.time)) ? data.time.slice(0, 10) : null;
      const date = fromOg ?? fromTime ?? new Date().toISOString().slice(0, 10);
      return { caption: unwrapOgCaption(data.og), date };
    },
    { waitUntil: 'domcontentloaded', timeout: 45_000 },
  ).catch(() => null);
}

export async function scrapeCeoWatcher(context: BrowserContext): Promise<RawInsiderTrade[]> {
  const posts = await collectPostUrls(context);
  const out: RawInsiderTrade[] = [];
  let parsedPosts = 0;
  for (const url of posts) {
    const read = await readPost(context, url);
    await randomDelay();
    if (!read) continue;
    const trades = parseCeoWatcherCaption(read.caption, read.date, url);
    if (trades.length) parsedPosts++;
    out.push(...trades);
  }
  // The grid rendered posts but not one caption yielded a trade: either the
  // caption wording changed or every post page was blocked. Both are silent
  // failures worth surfacing rather than reporting as a healthy empty run.
  if (!out.length) {
    throw new Error(
      `CEOWatcher: ${posts.length} post(s) found but none yielded a trade — caption format or post access changed`,
    );
  }
  console.log(`[ceowatcher] ${out.length} trade(s) from ${parsedPosts}/${posts.length} post(s)`);
  return out;
}
