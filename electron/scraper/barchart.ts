import type { BrowserContext } from 'playwright';
import type { OptionsActivity } from '../../src/types';
import { withPage, randomDelay } from './browser';
import { parseDate, isValidTicker, canonicalTicker } from './util';
import { mapOptionsTable } from './optionsMap';

/**
 * Barchart unusual options activity. The page populates from Barchart's
 * internal core-api JSON — parsing that response directly (typed fields) is
 * immune to grid-markup changes, so it is the primary path; the shadow-DOM
 * grid walk remains as a fallback. Barchart has anti-bot measures; failures
 * fall back gracefully to an empty array.
 */
const URL = 'https://www.barchart.com/options/unusual-activity/stocks';

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$%,]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Map rows from Barchart's core-api options payload into OptionsActivity. */
export function mapCoreApiRows(rows: any[]): OptionsActivity[] {
  const out: OptionsActivity[] = [];
  for (const r of rows) {
    // core-api rows carry formatted strings at the top level and numerics
    // under `raw`; prefer raw, fall back to the formatted value.
    const raw = r?.raw ?? r;
    const pick = (key: string) => raw?.[key] ?? r?.[key];

    const rawTicker = String(pick('baseSymbol') ?? '');
    if (!isValidTicker(rawTicker)) continue;
    const ticker = canonicalTicker(rawTicker);

    const typeStr = String(pick('symbolType') ?? '').toLowerCase();
    const type: 'call' | 'put' = typeStr.includes('put') ? 'put' : 'call';

    const volume = num(pick('volume'));
    const last = num(pick('lastPrice'));
    const openInterest = num(pick('openInterest'));
    const strike = num(pick('strikePrice'));
    const underlying = num(pick('baseLastPrice')) ?? num(pick('baseSymbolPrice'));
    const dte = num(pick('daysToExpiration'));
    const expiry = parseDate(String(pick('expirationDate') ?? '')) || undefined;

    const notional = volume && last ? volume * last * 100 : 0;
    if (!notional && !volume) continue;

    let volOiRatio = num(pick('volumeOpenInterestRatio'));
    if ((volOiRatio == null || volOiRatio <= 0) && volume && openInterest) {
      volOiRatio = volume / openInterest;
    }

    let otmPercent: number | undefined;
    if (strike != null && underlying) {
      const callOtm = ((strike - underlying) / underlying) * 100;
      otmPercent = Math.round((type === 'put' ? -callOtm : callOtm) * 10) / 10;
    }

    // Prefer explicit direction fields from core-api when present; fall back to
    // call/put only when nothing indicates buy/sell or bull/bear.
    const dirRaw = String(
      pick('sentiment') ?? pick('direction') ?? pick('tradeSide') ?? pick('side') ?? pick('tradeType') ?? '',
    ).toLowerCase();
    let sentiment: 'bullish' | 'bearish';
    if (dirRaw.includes('bear') || dirRaw === 'sell' || dirRaw.includes('bid') || dirRaw.includes('sold')) {
      // Sell-to-open: sold calls = bearish, sold puts = bullish
      if (dirRaw.includes('sell') || dirRaw.includes('bid') || dirRaw.includes('sold')) {
        sentiment = type === 'put' ? 'bullish' : 'bearish';
      } else {
        sentiment = 'bearish';
      }
    } else if (dirRaw.includes('bull') || dirRaw === 'buy' || dirRaw.includes('ask')) {
      if (dirRaw.includes('buy') || dirRaw.includes('ask')) {
        sentiment = type === 'put' ? 'bearish' : 'bullish';
      } else {
        sentiment = 'bullish';
      }
    } else {
      sentiment = type === 'put' ? 'bearish' : 'bullish';
    }

    out.push({
      ticker,
      type,
      sentiment,
      notional,
      premiumTotal: notional,
      strike,
      currentPrice: underlying,
      otmPercent,
      expiry,
      dte: dte != null ? Math.round(dte) : undefined,
      volume: volume || undefined,
      openInterest: openInterest || undefined,
      volOiRatio:
        volOiRatio != null && Number.isFinite(volOiRatio) && volOiRatio > 0
          ? Math.round(volOiRatio * 100) / 100
          : undefined,
      isSweep: false,
      source: 'barchart',
      sourceUrl: URL,
    });
  }
  return out;
}

export async function scrapeBarchart(context: BrowserContext): Promise<OptionsActivity[]> {
  return withPage(
    context,
    URL,
    async (page) => {
      // Primary path: capture the core-api JSON the grid loads from.
      try {
        const apiResponse = page.waitForResponse(
          (r) => r.url().includes('/proxies/core-api/v1/options') && r.status() === 200,
          { timeout: 25_000 },
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        const resp = await apiResponse;
        const json = (await resp.json()) as { data?: any[] };
        const fromApi = mapCoreApiRows(Array.isArray(json?.data) ? json.data : []);
        if (fromApi.length) return fromApi;
      } catch {
        /* fall through to the DOM fallback */
      }

      // Fallback: walk the client-rendered shadow-DOM grid.
      await page.waitForSelector('bc-data-grid', { timeout: 20_000 }).catch(() => undefined);
      await randomDelay(2500, 3500);

      const table = await page.evaluate(() => {
        const grid = document.querySelector('bc-data-grid');
        if (!grid || !grid.shadowRoot) return { headers: [], rows: [] };

        const getDeepText = (node: Node): string => {
          if (!node) return '';
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent || '';
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            const tagName = el.tagName.toUpperCase();
            if (tagName === 'STYLE' || tagName === 'SCRIPT') return '';
            if (tagName === 'BR') return '\n';

            let prefix = '';
            let suffix = '';
            if (tagName === 'DIV' || tagName === 'P') {
              prefix = '\n';
              suffix = '\n';
            }

            let inner = '';
            if (el.shadowRoot) {
              inner = Array.from(el.shadowRoot.childNodes).map(getDeepText).join('');
            } else {
              inner = Array.from(el.childNodes).map(getDeepText).join('');
            }
            return prefix + inner + suffix;
          }
          return Array.from(node.childNodes).map(getDeepText).join('');
        };

        const norm = (s: string | null) => {
          if (!s) return '';
          return s
            .replace(/[^\S\r\n]+/g, ' ') // collapse horizontal whitespace
            .replace(/\r?\n/g, '\n')     // normalize newlines
            .trim();
        };

        const headers = Array.from(grid.shadowRoot.querySelectorAll('._header_cell')).map(h => norm(getDeepText(h)));

        const elements = Array.from(grid.shadowRoot.querySelectorAll('*'));
        const rowDivs = elements.filter(e => {
          const className = e.className;
          const classStr = typeof className === 'string' ? className : (className && typeof className === 'object' && 'baseVal' in className ? (className as any).baseVal : '');
          return classStr && (classStr.includes('_row') || classStr.includes('row')) && e.children.length > 2;
        });

        const rows: string[][] = rowDivs.map(row => {
          const cells = Array.from(row.querySelectorAll('div._cell')).map(c => norm(getDeepText(c)));
          return cells;
        }).filter(row => row.length > 0);

        return { headers, rows };
      });

      return mapOptionsTable(table, 'barchart', URL);
    },
    { waitUntil: 'domcontentloaded', timeout: 40_000 },
  );
}
