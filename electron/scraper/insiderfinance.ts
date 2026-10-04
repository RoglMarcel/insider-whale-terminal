import type { BrowserContext } from 'playwright';
import type { OptionsActivity } from '../../src/types';
import { withPage, randomDelay } from './browser';
import { extractFirstTable } from './util';
import { mapOptionsTable } from './optionsMap';

/**
 * InsiderFinance flow. Like OptionStrat, the live flow normally requires an
 * account; we try an unauthenticated read and fall back gracefully. Disabled by
 * default in settings.
 */
const URL = 'https://www.insiderfinance.io/flow';

export async function scrapeInsiderFinance(context: BrowserContext): Promise<OptionsActivity[]> {
  return withPage(
    context,
    URL,
    async (page) => {
      // Wait for grid headers and table rows to appear
      await page.waitForSelector('div:has-text("Ticker"):has-text("Expiry")', { timeout: 20_000 }).catch(() => undefined);
      await page.waitForSelector('div[class*="sc-ckj5f5-2"], div[class*="HinVa"], div[class*="dVUUnp"]', { timeout: 15_000 }).catch(() => undefined);
      await randomDelay(3000, 4500);

      const table = await page.evaluate(() => {
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
            .replace(/[^\S\r\n]+/g, ' ')
            .replace(/\r?\n/g, '\n')
            .trim();
        };

        const rowEls = Array.from(document.querySelectorAll('div')).filter(el => {
          const className = el.className || '';
          const classStr = typeof className === 'string' ? className : (className && typeof className === 'object' && 'baseVal' in className ? (className as any).baseVal : '');
          const isRow = classStr && (classStr.includes('sc-ckj5f5-2') || classStr.includes('HinVa') || classStr.includes('dVUUnp'));
          if (!isRow) return false;
          
          // Must contain cell child nodes directly to be the inner row
          const cellChildren = Array.from(el.childNodes).filter(node => node.textContent?.trim());
          return cellChildren.length > 5;
        });

        const parsedRows = rowEls.map(row => {
          const cells = Array.from(row.childNodes).map(node => norm(getDeepText(node)));
          return cells.filter(c => c.length > 0);
        }).filter(row => row.length > 5);

        if (parsedRows.length === 0) {
          return { headers: [] as string[], rows: [] as string[][] };
        }

        let headers: string[] = [];
        let rows = parsedRows;
        const firstRow = parsedRows[0];
        const hasTicker = firstRow.some(cell => {
          const c = cell.toLowerCase();
          return c.includes('ticker') || c.includes('symbol') || c.includes('time') || c.includes('expiry');
        });

        if (hasTicker) {
          headers = firstRow;
          rows = parsedRows.slice(1);
        } else {
          headers = ['Time', 'Ticker', 'Expiry', 'C/P', 'Spot', 'Strike', 'OTM', 'Price', 'Size', 'Open Interest', 'Implied Vol', 'Type', 'Premium', 'Sector', 'Heat Score'];
        }

        return { headers, rows };
      });

      return mapOptionsTable(table, 'insiderfinance', URL);
    },
    { waitUntil: 'domcontentloaded' },
  );
}

