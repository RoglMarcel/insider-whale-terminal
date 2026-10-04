import { utcDateMs } from '../../src/lib/utcDate';
import type { Page } from 'playwright';

// ──────────────────────────────────────────────────────────────────────────
// Value parsing — scraped cells are messy strings; normalize to raw numbers.
// ──────────────────────────────────────────────────────────────────────────

/** Parse "$1,234,567", "+$1.2M", "(450K)", "-12,000" → a raw JS number. */
export function parseMoney(raw?: string | null): number {
  if (raw == null) return 0;
  const trimmed = String(raw).trim();
  if (!trimmed) return 0;
  // Financial sites render the sign as a typographic minus (U+2212) or an
  // en/em dash as often as an ASCII hyphen. Reading only '-' silently turned
  // "−34.2%" into +34.2 — which flips, for example, the 52-week-drawdown sign.
  const negative = /^\(.*\)$/.test(trimmed) || /^[-−‒–—]/.test(trimmed);
  // First number in the string, plus a k/m/b magnitude suffix ONLY when it
  // immediately follows the digits. This anchors the suffix to the numeric token,
  // so "1,000 mln" parses as 1000 (not 1e9) and a stray letter elsewhere is ignored,
  // while "3M" / "$1.2M" still scale correctly.
  // Word-boundary after suffix so "40B shares" scales but "Buy" / "Block" do not.
  const m = trimmed.replace(/,/g, '').match(/(\d*\.?\d+)([kmb])?(?![a-z])/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return 0;
  const suffix = (m[2] || '').toLowerCase();
  const mult = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1;
  return (negative ? -1 : 1) * n * mult;
}

/** Parse a share/quantity string into a number (absolute value). */
export function parseShares(raw?: string | null): number {
  return Math.abs(parseMoney(raw));
}

/** No real Form 4 open-market buy exceeds this (excludes mega-M&A block misreads). */
export const MAX_SANE_TRADE_VALUE = 5_000_000_000;
/** BRK.A is ~$700k/share; anything above $1M/share is almost certainly a unit error. */
export const MAX_SANE_SHARE_PRICE = 1_000_000;
/** Defensive share-count ceiling for a single Form 4 line. */
export const MAX_SANE_SHARES = 500_000_000;

export interface SanitizedAmounts {
  shares: number;
  price?: number;
  value: number;
}

/**
 * Normalize shares/price/value and drop impossible combinations (e.g. Insider
 * Monitor mis-parsing "40,000,000 $13.25" as price=$40,000,000 → $1.6e15 value).
 * Returns null when the row cannot be salvaged — caller should skip the trade.
 */
export function sanitizeTradeAmounts(
  shares: number,
  price: number | undefined,
  value: number,
): SanitizedAmounts | null {
  let s = Number.isFinite(shares) && shares > 0 ? shares : 0;
  let p = price != null && Number.isFinite(price) && price > 0 ? price : undefined;
  let v = Number.isFinite(value) && value > 0 ? Math.abs(value) : 0;

  // Prefer an explicit value column when product of shares×price is absurd.
  if (s > 0 && p != null && s * p > MAX_SANE_TRADE_VALUE) {
    if (v > 0 && v <= MAX_SANE_TRADE_VALUE) {
      p = v / s;
    } else if (p > MAX_SANE_SHARE_PRICE && v <= 0) {
      // Classic unit glitch: price was parsed as the share count (or value).
      // Drop price and wait for value; if still no value, drop the row.
      p = undefined;
    } else {
      return null;
    }
  }

  if (!v && s > 0 && p != null) v = s * p;
  if (v > MAX_SANE_TRADE_VALUE) {
    if (s > 0 && p != null && s * p > 0 && s * p <= MAX_SANE_TRADE_VALUE) v = s * p;
    else return null;
  }
  if (p != null && p > MAX_SANE_SHARE_PRICE) {
    if (v > 0 && s > 0) p = v / s;
    if (p > MAX_SANE_SHARE_PRICE) return null;
  }
  if (s > MAX_SANE_SHARES) {
    if (v > 0 && p != null && p > 0) s = Math.round(v / p);
    if (s > MAX_SANE_SHARES || s <= 0) return null;
  }
  if (!(v > 0)) return null;
  if (s > 0 && p == null) {
    // Deriving the price here used to bypass the MAX_SANE_SHARE_PRICE check
    // above, so the function could RETURN a price it would itself reject —
    // e.g. (shares 1, value $5M) → price $5M/share. Feeding that output back in
    // then returned null, making the whole function non-idempotent (and, via
    // the caller, scoring non-idempotent: 57.1 on the first pass, 0 on the
    // second). An implausible derived price means the SHARE COUNT is unreliable,
    // not that the trade is fake — the value column still stands, and price is
    // display-only, so drop just the price.
    const derived = v / s;
    if (derived <= MAX_SANE_SHARE_PRICE) p = derived;
  }
  return { shares: s, price: p, value: v };
}

// ──────────────────────────────────────────────────────────────────────────
// Ticker validation / canonicalization
// ──────────────────────────────────────────────────────────────────────────

/**
 * A US-listed equity symbol: 1–5 letters, optionally a share-class suffix
 * (`BRK.B`, `LEN-B`). Deliberately letters-only — every symbol that failed this
 * rule in the live database was garbage, never a real ticker:
 * `-` (a Quiver dash cell carrying a $6M trade), `NVDAEARNINGS` (an
 * InsiderFinance grid label scored as a $5.4M call), `3.MONTHMATURE`,
 * `GLASFUNDS`, `TE1` (Capitol Trades bond rows), and the Finviz
 * doubled-first-letter symbols `DDGICA` / `GGLIBA` / `LLILAK` / `FFCNCA`.
 */
const TICKER_SHAPE = /^[A-Z]{1,5}([.\-][A-Z]{1,2})?$/;

/**
 * "No value" markers that survive character cleaning and would otherwise become
 * a plausible-looking symbol — most importantly `N/A`, which `cleanTicker`
 * reduces to the two perfectly valid-looking letters `NA`. Checked against the
 * RAW cell, before cleaning, because that is the only point where the
 * information is still there. (senatewatcher/capitoltrades each carried their
 * own ad-hoc version of this check; this is the shared one.)
 */
const TICKER_SENTINEL = /^(n\/?a|none|null|undefined|nil|tbd|unknown|[-–—.]{1,3})$/i;

/** True if `raw` looks like a real equity symbol (see TICKER_SHAPE). */
export function isValidTicker(raw?: string | null): boolean {
  const s = String(raw ?? '').trim();
  if (!s || TICKER_SENTINEL.test(s)) return false;
  return TICKER_SHAPE.test(canonicalTicker(s));
}

/**
 * Canonical form of a symbol: uppercase, and the share-class separator
 * normalized to a DOT. Sources disagree — SEC/Yahoo write `BRK-B`, OpenInsider
 * and stockanalysis.com write `BRK.B` — and without this the same company was
 * carried as two tickers (`BRK.B`, `BRK-A`, plus the corrupted `BBRK-A`), each
 * with its own signal, and `isBigPlayer('BRK-B')` was false while
 * `isBigPlayer('BRK.B')` was true.
 *
 * The dot form is chosen because `BIG_PLAYERS` and stockanalysis.com already use
 * it; `yahooTicker()` converts back for the price APIs.
 */
export function canonicalTicker(raw?: string | null): string {
  return cleanTicker(raw).replace(/-/g, '.');
}

/** Symbol in the form Yahoo Finance's chart API expects (`BRK.B` → `BRK-B`). */
export function yahooTicker(raw?: string | null): string {
  return canonicalTicker(raw).replace(/\./g, '-');
}

/**
 * Repair a symbol whose FIRST LETTER was doubled by a source that renders a logo
 * chip inside the ticker cell (Finviz: the chip's fallback letter is part of
 * `textContent`, so `ALK` reads as `AALK`).
 *
 * The pattern alone cannot decide this — `AAPL`, `AAT`, `BBBY`, `QQQ`, `LLY`,
 * `KKR` and 15 other real symbols start with a doubled letter. The SEC's
 * registry is the oracle, and the rule is the one already used for the v1.1.12
 * cleanup: repair only when the symbol as read is NOT registered AND its
 * de-doubled form IS. Ambiguous cases are left alone; with no registry at hand
 * nothing is changed at all — a wrong "repair" is worse than the corruption.
 *
 * Measured on the live database: 143 of 689 tickers (20.8%) were corrupted this
 * way, all from Finviz, while all 21 genuinely doubled symbols are spared.
 */
export function repairDoubledTicker(ticker: string, isRegistered: (t: string) => boolean): string {
  const t = canonicalTicker(ticker);
  // Backreference: the first two characters must be the SAME letter.
  if (!/^([A-Z])\1/.test(t)) return t;
  if (isRegistered(t)) return t;
  const dedoubled = t.slice(1);
  return dedoubled.length >= 1 && isRegistered(dedoubled) ? dedoubled : t;
}

/**
 * Canonicalize every row's ticker and drop the ones that are not symbols at all.
 * Returns the rejects so a run can REPORT how much it threw away instead of
 * discarding it silently — a scraper whose ticker column moves would otherwise
 * look like a scraper that simply found nothing.
 */
export function sanitizeTickerRows<T extends { ticker: string }>(
  rows: readonly T[],
  /** Optional SEC-registry oracle; when given, doubled first letters are repaired. */
  isRegistered?: (t: string) => boolean,
): { kept: T[]; rejected: string[]; repaired: number } {
  const kept: T[] = [];
  const rejected: string[] = [];
  let repaired = 0;
  for (const row of rows) {
    let ticker = canonicalTicker(row.ticker);
    if (!isValidTicker(ticker)) {
      rejected.push(String(row.ticker ?? ''));
      continue;
    }
    if (isRegistered) {
      const fixed = repairDoubledTicker(ticker, isRegistered);
      if (fixed !== ticker) {
        repaired++;
        ticker = fixed;
      }
    }
    kept.push(ticker === row.ticker ? row : { ...row, ticker });
  }
  return { kept, rejected, repaired };
}

export function parseDate(raw?: string | null): string {
  if (!raw) return '';
  const cleaned = String(raw).trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';

  // 1. Try ISO pattern: YYYY-MM-DD or YYYY/MM/DD
  const matchIso = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (matchIso) {
    const y = matchIso[1];
    const m = matchIso[2].padStart(2, '0');
    const d = matchIso[3].padStart(2, '0');
    const iso = `${y}-${m}-${d}`;
    return utcDateMs(iso) === null ? '' : iso;
  }

  // 2. Try US slash pattern: MM/DD/YYYY or MM/DD/YY
  const matchSlash = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (matchSlash) {
    const m = matchSlash[1].padStart(2, '0');
    const d = matchSlash[2].padStart(2, '0');
    let y = matchSlash[3];
    if (y.length === 2) {
      y = '20' + y;
    }
    const iso = `${y}-${m}-${d}`;
    return utcDateMs(iso) === null ? '' : iso;
  }

  // 3. Month-name + day with NO year (e.g. Finviz "Jul 01"): Date.parse would
  // read the day as the year 2001. Assume the current year, rolling back one
  // year if that lands in the future (a trade date can't be forward-dated).
  // Strings that DO carry a year ("Jul 1, 2026" / "Jul 01 2026") fall through.
  const matchMonthDay = cleaned.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\b(?!\s*,)(?!\s+\d{4}\b)/);
  if (matchMonthDay) {
    const year = new Date().getFullYear();
    const candidate = new Date(`${matchMonthDay[1]} ${matchMonthDay[2]}, ${year}`);
    if (!Number.isNaN(candidate.getTime())) {
      if (candidate.getDate() !== Number(matchMonthDay[2])) return '';
      if (candidate.getTime() > Date.now() + 86_400_000) candidate.setFullYear(year - 1);
      const y = candidate.getFullYear();
      const m = String(candidate.getMonth() + 1).padStart(2, '0');
      const d = String(candidate.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // 4. Fallback to JS Date parsing (parsed in local time for non-ISO formats)
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) {
    const dateObj = new Date(t);
    const namedDay = /^(?:[A-Za-z]{3,9})\s+(\d{1,2})/.exec(cleaned) ?? /^(\d{1,2})\s+[A-Za-z]{3,9}/.exec(cleaned);
    if (namedDay && dateObj.getDate() !== Number(namedDay[1])) return '';
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return '';
}

/** Normalize a ticker symbol (keeps dots/dashes for BRK.B-style symbols). */
export function cleanTicker(raw?: string | null): string {
  if (!raw) return '';
  return String(raw).trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
}

export function cleanText(raw?: string | null): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Generic HTML table extraction
// ──────────────────────────────────────────────────────────────────────────

export interface ExtractedTable {
  headers: string[];
  rows: string[][];
  rowUrls?: (string | null)[];
  /**
   * The selector that actually matched. A caller that needs to read something
   * else off the SAME rows (e.g. the authoritative ticker from a row's quote
   * link) must use this, or it may address a different table than the one whose
   * rows it is patching.
   */
  selector?: string;
}

/** Pull headers + body rows from the first matching table on the page. */
export async function extractTable(page: Page, selector: string): Promise<ExtractedTable> {
  return page.evaluate((sel: string) => {
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

    const table = document.querySelector(sel);
    if (!table) return { headers: [] as string[], rows: [] as string[][], rowUrls: [] as string[] };

    let headers: string[] = [];
    const headEls = table.querySelectorAll('thead th, thead td');
    if (headEls.length) headers = Array.from(headEls).map((e) => norm(getDeepText(e)));
    if (!headers.length) {
      const thRow = table.querySelector('tr');
      if (thRow && thRow.querySelectorAll('th').length) {
        headers = Array.from(thRow.querySelectorAll('th')).map((e) => norm(getDeepText(e)));
      }
    }

    const bodyRowEls = table.querySelectorAll('tbody tr');
    const rowEls = bodyRowEls.length ? bodyRowEls : table.querySelectorAll('tr');
    const rows: string[][] = [];
    const rowUrls: (string | null)[] = [];
    const pageUrl = window.location.href;

    rowEls.forEach((tr) => {
      // Check if it is a header row by checking if it contains th or td
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length) {
        const cells = tds.map((td) => norm(getDeepText(td)));
        rows.push(cells);

        // Find the best link in the row
        const anchors = Array.from(tr.querySelectorAll('a'));
        let bestUrl: string | null = null;
        let highestPriority = -1;

        for (const a of anchors) {
          let href = a.getAttribute('href');
          if (!href) continue;

          try {
            href = new URL(href, pageUrl).href;
          } catch {
            // ignore invalid urls
          }

          let priority = 0;
          if (href.includes('sec.gov/Archives/edgar/') || href.includes('sec.gov/Archives/') || href.includes('edgar/data/')) {
            priority = 10;
          } else if (href.includes('/s.php?id=') || href.includes('openinsider.com/s.php')) {
            priority = 9;
          } else if (href.includes('/filings/')) {
            priority = 8;
          } else if (href.includes('/insider-trades/') || href.includes('/insidertrades.com/')) {
            priority = 5;
          } else if (href.includes('/insider-trading/') || href.includes('/insider/')) {
            priority = 3;
          } else if (href.includes('/stock/') || href.includes('/quote.ashx') || href.includes('/stocks/')) {
            priority = 2;
          } else {
            priority = 1;
          }

          if (priority > highestPriority) {
            highestPriority = priority;
            bestUrl = href;
          }
        }
        rowUrls.push(bestUrl);
      }
    });
    return { headers, rows, rowUrls };
  }, selector);
}

/** Try each selector in order; return the first table that yields rows. */
export async function extractFirstTable(page: Page, selectors: string[]): Promise<ExtractedTable> {
  let empty: ExtractedTable | undefined;
  for (const sel of selectors) {
    try {
      const t = await extractTable(page, sel);
      if (t.rows.length) return { ...t, selector: sel };
      if (t.headers.length) empty = { ...t, selector: sel };
    } catch {
      /* try next selector */
    }
  }
  if (empty) return empty;
  throw new Error('Source table missing or unreadable; empty result is not confirmed');
}

/**
 * Read one attribute-derived value PER ROW of an already-extracted table, using
 * the same selector and the same "rows that contain a <td>" rule as
 * `extractTable`, so the result is index-aligned with `table.rows`.
 *
 * This exists because keying such a lookup on the rendered CELL TEXT is unsafe:
 * `extractTable` builds its text via `getDeepText`, which inserts newlines
 * around DIV/P, while `td.textContent` does not — so the two spellings of the
 * same cell can differ and the lookup silently misses. That is how Finviz's
 * doubled-first-letter tickers (BRK-A → BBRK-A) survived the repair.
 */
export async function extractRowAttribute(
  page: Page,
  selector: string,
  pattern: string,
): Promise<(string | null)[]> {
  return page.evaluate(
    ({ sel, pat }: { sel: string; pat: string }) => {
      const table = document.querySelector(sel);
      if (!table) return [] as (string | null)[];
      const bodyRowEls = table.querySelectorAll('tbody tr');
      const rowEls = bodyRowEls.length ? bodyRowEls : table.querySelectorAll('tr');
      const re = new RegExp(pat);
      const out: (string | null)[] = [];
      rowEls.forEach((tr) => {
        if (!tr.querySelectorAll('td').length) return; // same filter as extractTable
        let found: string | null = null;
        for (const a of Array.from(tr.querySelectorAll('a'))) {
          const m = re.exec(a.getAttribute('href') || '');
          if (m && m[1]) {
            found = m[1];
            break;
          }
        }
        out.push(found);
      });
      return out;
    },
    { sel: selector, pat: pattern },
  );
}

/** Find the index of the column whose header matches any alias (substring, case-insensitive). */
export function colIndex(headers: string[], aliases: string[]): number {
  const lower = headers.map((h) => h.toLowerCase());
  for (const alias of aliases) {
    const a = alias.toLowerCase();
    const i = lower.findIndex((h) => h.includes(a));
    if (i >= 0) return i;
  }
  return -1;
}

/** Safe cell read by index. */
export function cell(row: string[], idx: number): string {
  return idx >= 0 && idx < row.length ? row[idx] : '';
}

export type StockPageVerdict = 'ok' | 'missing' | 'transient';

/**
 * What a stockanalysis.com `/stocks/<ticker>/` response means for the
 * enrichment cache. Split out from the fetch so the DECISION is testable
 * without a network — getting it wrong is silent and expensive in both
 * directions.
 *
 * - `ok`        — a real stock page; parse it.
 * - `missing`   — the symbol has no stock page here and will not grow one:
 *                a bad ticker (404/410), or a 200 that REDIRECTED away from
 *                `/stocks/` because the symbol is an ETF (QQQ, SPY → `/etf/…`)
 *                or a renamed listing (FB → META). Stable, therefore cacheable.
 * - `transient` — 429, 5xx, anything else. NEVER cacheable: caching one blip
 *                suppresses a real ticker for the whole TTL, the same trap the
 *                track-record cache already documents.
 *
 * Note what is deliberately NOT a signal here: "the parse came back empty".
 * Keying cacheability on an empty parse would negative-cache the entire
 * universe for a full TTL the day the site changes its HTML.
 */
export function classifyStockPageResponse(status: number, redirected: boolean): StockPageVerdict {
  if (status === 404 || status === 410) return 'missing';
  if (status < 200 || status >= 300) return 'transient';
  return redirected ? 'missing' : 'ok';
}
