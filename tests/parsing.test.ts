import { describe, it, expect } from 'vitest';
import {
  parseMoney,
  parseShares,
  parseDate,
  cleanTicker,
  cleanText,
  sanitizeTradeAmounts,
  isValidTicker,
  canonicalTicker,
  yahooTicker,
  sanitizeTickerRows,
  repairDoubledTicker,
  classifyStockPageResponse,
  MAX_SANE_TRADE_VALUE,
  MAX_SANE_SHARE_PRICE,
  MAX_SANE_SHARES,
} from '../electron/scraper/util';

describe('parseMoney', () => {
  it('handles the common shapes', () => {
    expect(parseMoney('$1,234,567')).toBe(1_234_567);
    expect(parseMoney('1234567')).toBe(1_234_567);
    expect(parseMoney('$1.2M')).toBe(1_200_000);
    expect(parseMoney('3M')).toBe(3_000_000);
    expect(parseMoney('450K')).toBe(450_000);
    expect(parseMoney('40B')).toBe(40_000_000_000);
    expect(parseMoney('12.5')).toBe(12.5);
  });
  it('reads parentheses and a leading hyphen as negative', () => {
    expect(parseMoney('(450K)')).toBe(-450_000);
    expect(parseMoney('-12,000')).toBe(-12_000);
  });
  it('reads a Unicode minus / dash as negative (regression)', () => {
    expect(parseMoney('−34.2')).toBe(-34.2); // U+2212 MINUS SIGN
    expect(parseMoney('–12.5')).toBe(-12.5); // EN DASH
    expect(parseMoney('—12.5')).toBe(-12.5); // EM DASH
  });
  it('anchors the magnitude suffix to the number', () => {
    expect(parseMoney('1,000 mln')).toBe(1000);
    expect(parseMoney('Block')).toBe(0);
    expect(parseMoney('Buy')).toBe(0);
  });
  it('empty / null / non-numeric → 0', () => {
    expect(parseMoney('')).toBe(0);
    expect(parseMoney(null)).toBe(0);
    expect(parseMoney(undefined)).toBe(0);
    expect(parseMoney('—')).toBe(0);
    expect(parseMoney('N/A')).toBe(0);
  });
  it('parseShares is the absolute value', () => {
    expect(parseShares('(1,000)')).toBe(1000);
    expect(parseShares('-500')).toBe(500);
  });
});

describe('parseDate', () => {
  it('ISO and slash forms', () => {
    expect(parseDate('2026-06-01')).toBe('2026-06-01');
    expect(parseDate('2026/6/1')).toBe('2026-06-01');
    expect(parseDate('06/01/2026')).toBe('2026-06-01');
    expect(parseDate('6/1/26')).toBe('2026-06-01');
  });
  it('a month+day with NO year assumes the current year, never year 2001', () => {
    const out = parseDate('Jul 01');
    expect(out).toMatch(/^\d{4}-07-01$/);
    expect(Number(out.slice(0, 4))).toBeGreaterThan(2000);
  });
  it('a month+day WITH a year is left to the full parser', () => {
    expect(parseDate('Jul 1, 2024')).toBe('2024-07-01');
  });
  it('a no-year date is never forward-dated by more than a day', () => {
    const parsed = parseDate('Dec 31');
    const t = new Date(`${parsed}T00:00:00`).getTime();
    expect(t).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000);
  });
  it('unparseable → empty string, never a wrong date', () => {
    expect(parseDate('')).toBe('');
    expect(parseDate(null)).toBe('');
    expect(parseDate('not a date')).toBe('');
    expect(parseDate('—')).toBe('');
  });
});

describe('cleanTicker / cleanText', () => {
  it('uppercases and strips illegal characters', () => {
    expect(cleanTicker(' aapl ')).toBe('AAPL');
    expect(cleanTicker('BRK.B')).toBe('BRK.B');
    expect(cleanTicker('BRK-B')).toBe('BRK-B');
    expect(cleanTicker('A/B')).toBe('AB');
  });
  it('bounds the length', () => {
    expect(cleanTicker('ABCDEFGHIJKLMNOP').length).toBeLessThanOrEqual(12);
  });
  it('empty in, empty out', () => {
    expect(cleanTicker('')).toBe('');
    expect(cleanTicker(null)).toBe('');
  });
  it('cleanText collapses whitespace', () => {
    expect(cleanText('  a\n  b  ')).toBe('a b');
    expect(cleanText(null)).toBe('');
  });
});

describe('ticker validation + canonicalization', () => {
  it('accepts real symbols including share classes', () => {
    for (const t of ['A', 'AAPL', 'GOOGL', 'BRK.B', 'BRK-B', 'LEN-B', 'MOG.A']) {
      expect(isValidTicker(t)).toBe(true);
    }
  });
  it('rejects every junk symbol that reached the live database', () => {
    for (const t of ['-', '--', 'NVDAEARNINGS', '3.MONTHMATURE', 'GLASFUNDS', 'TE1', 'DDGICA', 'GGLIBA', 'LLILAK', 'FFCNCA', '', 'N/A']) {
      expect(isValidTicker(t)).toBe(false);
    }
  });
  it('canonicalizes the share-class separator to a dot', () => {
    expect(canonicalTicker('BRK-B')).toBe('BRK.B');
    expect(canonicalTicker('brk.b')).toBe('BRK.B');
    expect(canonicalTicker('AAPL')).toBe('AAPL');
  });
  it('yahooTicker converts back to the dash form Yahoo expects', () => {
    expect(yahooTicker('BRK.B')).toBe('BRK-B');
    expect(yahooTicker('BRK-B')).toBe('BRK-B');
    expect(yahooTicker('AAPL')).toBe('AAPL');
  });
  it('canonical → yahoo → canonical is a round trip', () => {
    for (const t of ['AAPL', 'BRK.B', 'BRK-B', 'LEN-B']) {
      expect(canonicalTicker(yahooTicker(t))).toBe(canonicalTicker(t));
    }
  });
  it('sanitizeTickerRows keeps the good rows and REPORTS the rejects', () => {
    const rows = [{ ticker: 'aapl' }, { ticker: 'BRK-B' }, { ticker: '-' }, { ticker: 'NVDAEARNINGS' }];
    const { kept, rejected } = sanitizeTickerRows(rows);
    expect(kept.map((r) => r.ticker)).toEqual(['AAPL', 'BRK.B']);
    expect(rejected).toEqual(['-', 'NVDAEARNINGS']);
  });
  it('sanitizeTickerRows does not mutate its input', () => {
    const rows = [{ ticker: 'brk-b' }];
    const before = JSON.stringify(rows);
    sanitizeTickerRows(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('sanitizeTradeAmounts', () => {
  it('computes the missing field', () => {
    expect(sanitizeTradeAmounts(100, 10, 0)).toEqual({ shares: 100, price: 10, value: 1000 });
    expect(sanitizeTradeAmounts(100, undefined, 1000)).toEqual({ shares: 100, price: 10, value: 1000 });
  });
  it('rejects a row with no usable value', () => {
    expect(sanitizeTradeAmounts(0, undefined, 0)).toBeNull();
    expect(sanitizeTradeAmounts(100, undefined, 0)).toBeNull();
    expect(sanitizeTradeAmounts(NaN, NaN, NaN)).toBeNull();
  });
  it('repairs the classic unit glitch (price parsed as the share count)', () => {
    // 40,000,000 shares at a "price" of 13.25 is fine; 40,000,000 as the PRICE is not.
    const out = sanitizeTradeAmounts(40_000_000, 40_000_000, 530_000_000);
    expect(out).not.toBeNull();
    expect(out!.value).toBeLessThanOrEqual(MAX_SANE_TRADE_VALUE);
    expect(out!.price!).toBeLessThanOrEqual(MAX_SANE_SHARE_PRICE);
  });
  it('never RETURNS a price above its own ceiling (regression)', () => {
    const out = sanitizeTradeAmounts(1, undefined, 5_000_000);
    expect(out).not.toBeNull();
    expect(out!.value).toBe(5_000_000);
    expect(out!.price === undefined || out!.price <= MAX_SANE_SHARE_PRICE).toBe(true);
  });
  it('is IDEMPOTENT — feeding its own output back yields the same result', () => {
    const inputs: [number, number | undefined, number][] = [
      [100, 10, 0],
      [1, undefined, 5_000_000],
      [40_000_000, 40_000_000, 530_000_000],
      [1000, undefined, 250_072],
      [0, undefined, 1_000_000],
    ];
    for (const [s, p, v] of inputs) {
      const a = sanitizeTradeAmounts(s, p, v);
      if (!a) continue;
      const b = sanitizeTradeAmounts(a.shares, a.price, a.value);
      expect(b).toEqual(a);
    }
  });
  it('honours all three sanity ceilings', () => {
    expect(sanitizeTradeAmounts(1, MAX_SANE_SHARE_PRICE * 10, 0)).toBeNull();
    expect(sanitizeTradeAmounts(MAX_SANE_SHARES * 10, 1, 0)).toBeNull();
    const big = sanitizeTradeAmounts(1, undefined, MAX_SANE_TRADE_VALUE * 10);
    expect(big).toBeNull();
  });
  it('negative inputs are treated as absent, never as negative money', () => {
    const out = sanitizeTradeAmounts(-100, -5, -1000);
    expect(out === null || out.value > 0).toBe(true);
  });
});

describe('repairDoubledTicker (Finviz logo-glyph corruption)', () => {
  // The real SEC registry state for the symbols this rule has to separate.
  const REGISTERED = new Set([
    'AAPL', 'AAT', 'BBBY', 'BBW', 'CC', 'CCC', 'CCHH', 'CCL', 'EEFT', 'FFIN',
    'KKR', 'LLY', 'MMED', 'QQQ', 'RRBI', 'SSTI', 'UUU', 'UUUU', 'VVV', 'WW', 'WWW',
    'ACDC', 'ALK', 'ALTO', 'AMH', 'ARE', 'ASND', 'DGICA', 'BRK.A', 'BRK.B', 'CORZ', 'ET', 'ETN',
  ]);
  const isRegistered = (t: string) => REGISTERED.has(t);

  it('leaves genuinely doubled symbols alone', () => {
    for (const t of ['AAPL', 'AAT', 'BBBY', 'QQQ', 'LLY', 'KKR', 'CCL', 'VVV', 'WWW']) {
      expect(repairDoubledTicker(t, isRegistered)).toBe(t);
    }
  });
  it('repairs a corrupted symbol whose de-doubled form is registered', () => {
    expect(repairDoubledTicker('AAAT', isRegistered)).toBe('AAT');
    expect(repairDoubledTicker('AACDC', isRegistered)).toBe('ACDC');
    expect(repairDoubledTicker('AALK', isRegistered)).toBe('ALK');
    expect(repairDoubledTicker('AARE', isRegistered)).toBe('ARE');
    expect(repairDoubledTicker('DDGICA', isRegistered)).toBe('DGICA');
    expect(repairDoubledTicker('CCORZ', isRegistered)).toBe('CORZ');
    expect(repairDoubledTicker('EET', isRegistered)).toBe('ET');
    expect(repairDoubledTicker('EETN', isRegistered)).toBe('ETN');
  });
  it('repairs share classes through the canonical form', () => {
    expect(repairDoubledTicker('BBRK-A', isRegistered)).toBe('BRK.A');
    expect(repairDoubledTicker('BBRK-B', isRegistered)).toBe('BRK.B');
  });
  it('leaves the symbol alone when NEITHER form is registered', () => {
    expect(repairDoubledTicker('AAXIA', isRegistered)).toBe('AAXIA');
  });
  it('never touches a symbol without a doubled first letter', () => {
    for (const t of ['NVDA', 'MSFT', 'BRK.B', 'A']) {
      expect(repairDoubledTicker(t, isRegistered)).toBe(canonicalTicker(t));
    }
  });
  it('changes nothing when the registry is empty (never guess)', () => {
    const none = () => false;
    for (const t of ['AAAT', 'AACDC', 'AAPL']) expect(repairDoubledTicker(t, none)).toBe(t);
  });
  it('sanitizeTickerRows applies the repair and counts it', () => {
    const rows = [{ ticker: 'AALK' }, { ticker: 'AAPL' }, { ticker: 'NVDA' }, { ticker: '-' }];
    const out = sanitizeTickerRows(rows, isRegistered);
    expect(out.kept.map((r) => r.ticker)).toEqual(['ALK', 'AAPL', 'NVDA']);
    expect(out.repaired).toBe(1);
    expect(out.rejected).toEqual(['-']);
  });
  it('sanitizeTickerRows without an oracle repairs nothing', () => {
    const out = sanitizeTickerRows([{ ticker: 'AALK' }]);
    expect(out.kept.map((r) => r.ticker)).toEqual(['AALK']);
    expect(out.repaired).toBe(0);
  });
});

/**
 * The cacheability verdict decides whether a failed enrichment is remembered.
 * Too eager and one layout change negative-caches the whole universe for a TTL;
 * too shy and dead symbols are refetched on every run — which is what consumed
 * the 60s enrichment budget and pinned marketCap coverage at 449 of 689.
 */
describe('classifyStockPageResponse', () => {
  it('treats a real, non-redirected page as parseable', () => {
    expect(classifyStockPageResponse(200, false)).toBe('ok');
  });

  it('treats 404 and 410 as a permanent miss', () => {
    expect(classifyStockPageResponse(404, false)).toBe('missing');
    expect(classifyStockPageResponse(410, false)).toBe('missing');
  });

  it('treats a 200 that redirected away from /stocks/ as a permanent miss', () => {
    // Measured against the live site: ETFs (QQQ, SPY) and renamed listings
    // (FB → META) all answer 200 AND redirect, then parse to nothing.
    expect(classifyStockPageResponse(200, true)).toBe('missing');
  });

  it('never marks a rate limit or a server error as cacheable', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyStockPageResponse(status, false)).toBe('transient');
      expect(classifyStockPageResponse(status, true)).toBe('transient');
    }
  });

  it('assigns exactly one verdict to every status code', () => {
    for (let status = 100; status < 600; status++) {
      for (const redirected of [true, false]) {
        expect(['ok', 'missing', 'transient']).toContain(classifyStockPageResponse(status, redirected));
      }
    }
  });
});
