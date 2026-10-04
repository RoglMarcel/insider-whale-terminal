import { isLoggedIn, loadMergedStorageState } from '../auth';
import { insertNewsItem } from '../database';
import { launchBrowser, createContext, withPage } from './browser';
import { Notification } from 'electron';
import type { Browser, BrowserContext } from 'playwright';

const TWITTER_URL = 'https://x.com/WhaleInsider';
const NEWS_WINDOW_MS = 12 * 60 * 60 * 1000;

// Single-flight guard: the news cron + the immediate startup trigger can overlap,
// and a slow scrape shouldn't stack a second browser on top of the first.
let twitterScrapeInFlight = false;

export async function runTwitterScrape(opts: { headless: boolean }): Promise<void> {
  if (!isLoggedIn('twitter')) {
    console.log('[twitter-scraper] Skip: Twitter/X is not logged in.');
    return;
  }
  if (twitterScrapeInFlight) {
    console.log('[twitter-scraper] Skip: a news scrape is already running.');
    return;
  }
  twitterScrapeInFlight = true;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    const storageState = loadMergedStorageState(['twitter']);
    browser = await launchBrowser(opts.headless);
    context = await createContext(browser, storageState);

    await withPage(
      context,
      TWITTER_URL,
      async (page) => {
        // Wait for tweets to render
        await page.waitForSelector('[data-testid="tweet"]', { timeout: 20_000 });

        // Scroll to load beyond the initially-mounted handful of tweets so the
        // 12-hour window is actually covered after any pause in polling; stop
        // early once the oldest visible tweet is already outside the window.
        for (let i = 0; i < 5; i++) {
          await page.mouse.wheel(0, 2500);
          await page.waitForTimeout(1200);
          const oldestMs = await page.evaluate(() => {
            const times = document.querySelectorAll('[data-testid="tweet"] time');
            const last = times[times.length - 1];
            const dt = last?.getAttribute('datetime');
            return dt ? Date.parse(dt) : NaN;
          });
          if (!Number.isNaN(oldestMs) && Date.now() - oldestMs > NEWS_WINDOW_MS) break;
        }

        // Extract tweets text, IDs, links, and dates
        const tweets = await page.evaluate(() => {
          const tweetElements = document.querySelectorAll('[data-testid="tweet"]');
          const results: { tweetId: string; text: string; timestamp: string; url: string }[] = [];

          tweetElements.forEach((el) => {
            const textEl = el.querySelector('[data-testid="tweetText"]');
            const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement;
            const timeEl = el.querySelector('time') as HTMLTimeElement;

            if (linkEl) {
              const href = linkEl.getAttribute('href') || '';
              const match = href.match(/\/status\/(\d+)/);
              if (match) {
                const tweetId = match[1];
                const text = textEl ? textEl.textContent || '' : '';
                const timestamp = timeEl ? timeEl.getAttribute('datetime') || '' : new Date().toISOString();
                const url = 'https://x.com' + href;
                results.push({ tweetId, text, timestamp, url });
              }
            }
          });

          return results;
        });

        console.log(`[twitter-scraper] Found ${tweets.length} tweets on page.`);
        let newCount = 0;
        let latestTweetText = '';
        const cutoff = Date.now() - NEWS_WINDOW_MS;

        // Process in chronological order (oldest first); only notify on ≤12h posts.
        for (let i = tweets.length - 1; i >= 0; i--) {
          const tweet = tweets[i];
          const ts = tweet.timestamp ? Date.parse(tweet.timestamp) : NaN;
          if (Number.isNaN(ts) || ts < cutoff) continue;
          const inserted = insertNewsItem(tweet);
          if (inserted) {
            newCount++;
            latestTweetText = tweet.text;
          }
        }

        if (newCount > 0) {
          console.log(`[twitter-scraper] Inserted ${newCount} new tweets.`);

          if (Notification.isSupported()) {
            const body =
              newCount === 1 ? latestTweetText : `Found ${newCount} new updates from @WhaleInsider.`;

            const notification = new Notification({
              title: '@WhaleInsider News Alert',
              body: body.length > 120 ? body.substring(0, 117) + '...' : body,
              silent: false,
            });
            notification.show();
          }
        }
      },
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
  } catch (err) {
    console.error('[twitter-scraper] Error during scrape:', err);
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    twitterScrapeInFlight = false;
  }
}
