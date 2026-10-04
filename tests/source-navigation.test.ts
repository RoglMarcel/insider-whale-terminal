import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import { withPage } from '../electron/scraper/browser';
import { scrapeSecForm4 } from '../electron/scraper/secform4';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function page(status: number) {
  return {
    goto: vi.fn().mockResolvedValue({ ok: () => status === 200, status: () => status, headers: () => ({}) }),
    close: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ headers: [], rows: [] }),
  };
}

it('retries a temporary HTTP failure on a fresh page and closes both pages', async () => {
  const first = page(503), second = page(200);
  const context = { newPage: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
  const parse = vi.fn().mockResolvedValue(['valid row']);
  const result = withPage(context as unknown as BrowserContext, 'https://example.com', parse, { reliable: true });
  await vi.runAllTimersAsync();
  expect(await result).toEqual(['valid row']);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(parse).toHaveBeenCalledOnce();
});

it('SECForm4 does not swallow an access denial or retry it', async () => {
  const blocked = page(403);
  const context = { newPage: vi.fn().mockResolvedValue(blocked) };
  await expect(scrapeSecForm4(context as unknown as BrowserContext)).rejects.toThrow('HTTP 403');
  expect(context.newPage).toHaveBeenCalledOnce();
  expect(blocked.close).toHaveBeenCalledOnce();
});

it('SECForm4 rejects a successful HTTP response with no readable trade table', async () => {
  const empty = page(200);
  const context = { newPage: vi.fn().mockResolvedValue(empty) };
  await expect(scrapeSecForm4(context as unknown as BrowserContext)).rejects.toThrow('table missing or unreadable');
  expect(context.newPage).toHaveBeenCalledOnce();
  expect(empty.close).toHaveBeenCalledOnce();
});
