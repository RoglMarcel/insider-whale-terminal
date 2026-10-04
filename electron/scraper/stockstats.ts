import { scopedFetch } from './cancellation';
import { useScrapling, scraplingHtml } from './scrapling';
import { parseMoney } from './util';

/**
 * Equity stats pack — short interest, float, shares outstanding, average
 * volume from stockanalysis.com's /statistics/ page (same host the earnings
 * enrichment already uses; labels are span-wrapped inside comment-riddled
 * markup, so we strip comments and match label-through-</span>). Values are
 * cached in ticker_meta by the orchestrator alongside the quote-page fields.
 */

export interface EquityStats {
  /** Short interest as % of float (e.g. 18.4). */
  shortPctFloat?: number;
  /** Free-float share count. */
  floatShares?: number;
  sharesOutstanding?: number;
  /** Average daily share volume. */
  avgVolume?: number;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Value text for a labeled row; exact label first, then prefix (e.g. "Average Volume (20 Days)"). */
function statValue(clean: string, label: string): string | undefined {
  const esc = escapeRegExp(label);
  const exact = new RegExp(`>${esc}</span>\\s*</td><td[^>]*>\\s*([^<]+)`, 'i').exec(clean);
  if (exact) return exact[1].trim();
  const prefix = new RegExp(`>${esc}[^<]*</span>\\s*</td><td[^>]*>\\s*([^<]+)`, 'i').exec(clean);
  return prefix ? prefix[1].trim() : undefined;
}

function num(text: string | undefined): number | undefined {
  if (!text || text === '-' || text === '—' || /n\/a/i.test(text)) return undefined;
  const v = Math.abs(parseMoney(text.replace(/%/g, '')));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function parseStatsHtml(html: string): EquityStats {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  return {
    shortPctFloat: num(statValue(clean, 'Short % of Float')),
    floatShares: num(statValue(clean, 'Float')),
    sharesOutstanding: num(statValue(clean, 'Shares Outstanding')),
    avgVolume: num(statValue(clean, 'Average Volume')),
  };
}

export async function fetchStockAnalysisStats(ticker: string): Promise<EquityStats | null> {
  try {
    const url = `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/statistics/`;
    let html: string;
    if (useScrapling()) html = await scraplingHtml(url);
    else {
      const resp = await scopedFetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return null;
      html = await resp.text();
    }
    const stats = parseStatsHtml(html);
    return stats.shortPctFloat != null || stats.floatShares != null || stats.avgVolume != null ? stats : null;
  } catch {
    return null;
  }
}

/**
 * Price context at the buy — % distance of the ADJUSTED close on `asOfYmd`
 * (or latest if omitted) from the trailing 52-week high up to that bar
 * (≤ 0; −42.3 = "42% off the highs"). Adjusted closes only.
 */
export async function fetchDrawdown52w(ticker: string, asOfYmd?: string): Promise<number | undefined> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`;
    const res = await scopedFetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { adjclose?: Array<{ adjclose?: Array<number | null> }> };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const adj = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const points: { date: string; px: number }[] = [];
    ts.forEach((t, i) => {
      const v = adj[i];
      if (v != null && Number.isFinite(v) && v > 0) {
        points.push({ date: new Date(t * 1000).toISOString().slice(0, 10), px: v });
      }
    });
    if (points.length < 20) return undefined;

    let endIdx = points.length - 1;
    if (asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd)) {
      // First bar on or after asOf; if none, last bar on or before.
      let found = -1;
      for (let i = 0; i < points.length; i++) {
        if (points[i].date >= asOfYmd) {
          found = i;
          break;
        }
      }
      if (found < 0) found = points.length - 1;
      endIdx = found;
    }

    const window = points.slice(0, endIdx + 1);
    if (window.length < 20) return undefined;
    // Trailing ~252 trading days before the as-of bar.
    const start = Math.max(0, window.length - 252);
    const slice = window.slice(start);
    const high = Math.max(...slice.map((p) => p.px));
    const last = slice[slice.length - 1].px;
    if (!(high > 0)) return undefined;
    return Math.round(((last - high) / high) * 1000) / 10;
  } catch {
    return undefined;
  }
}
