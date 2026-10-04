import type { BrowserContext } from 'playwright';
import type { OptionsActivity } from '../../src/types';
import { withPage, randomDelay } from './browser';
import { extractFirstTable } from './util';
import { mapOptionsTable } from './optionsMap';

/**
 * OptionStrat flow. Public access is limited and usually needs an account, so
 * we attempt an unauthenticated read and fall back gracefully (requirement: try
 * without auth, fall back gracefully). Disabled by default in settings.
 */
const URL = 'https://optionstrat.com/flow/live';

export async function scrapeOptionStrat(context: BrowserContext): Promise<OptionsActivity[]> {
  return withPage(
    context,
    URL,
    async (page) => {
      await page.waitForSelector('table, [role="table"]', { timeout: 20_000 }).catch(() => undefined);
      await randomDelay(1500, 2500);
      const table = await extractFirstTable(page, ['table', '[role="table"]']);
      return mapOptionsTable(table, 'optionstrat', URL);
    },
    { waitUntil: 'domcontentloaded' },
  );
}
