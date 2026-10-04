import type { OptionsActivity, ScraperSource } from '../../src/types';
import {
  type ExtractedTable,
  colIndex,
  cell,
  parseMoney,
  parseShares,
  parseDate,
  cleanTicker,
  cleanText,
  isValidTicker,
  canonicalTicker,
} from './util';

/**
 * Map a generic unusual-options / flow table into normalized OptionsActivity[].
 * Extracts Feature-3 detail (dte, strike, underlying, OTM%, sweep, vol/OI,
 * premium) when those columns exist, computing them when they don't.
 */
/** Helper to parse fields out of a strategy column like "Sell 729 Call", "Buy 100 Put", or "100 Call" */
export function parseStrategy(strategyText: string): {
  type?: 'call' | 'put';
  strike?: number;
  action?: 'buy' | 'sell';
  sentiment?: 'bullish' | 'bearish';
} {
  const clean = strategyText.trim();
  if (!clean) return {};

  let type: 'call' | 'put' | undefined;
  let strike: number | undefined;
  let action: 'buy' | 'sell' | undefined;
  let sentiment: 'bullish' | 'bearish' | undefined;

  const lower = clean.toLowerCase();
  if (lower.includes('call') || /\bc\b/.test(lower)) {
    type = 'call';
  } else if (lower.includes('put') || /\bp\b/.test(lower)) {
    type = 'put';
  }

  // "Bull"/"bear" name the strategy's direction outright — they are sentiment,
  // not order actions (a bear put spread is BOUGHT but bearish). Sweep/block
  // describe execution, not direction, and imply nothing about either.
  if (lower.includes('bull')) sentiment = 'bullish';
  else if (lower.includes('bear')) sentiment = 'bearish';

  if (lower.includes('buy') || lower.includes('ask')) {
    action = 'buy';
  } else if (lower.includes('sell') || lower.includes('write') || lower.includes('bid')) {
    action = 'sell';
  }

  // Search for numeric strike price (supporting decimals)
  const numMatches = clean.replace(/,/g, '').match(/\b\d+(?:\.\d+)?\b/);
  if (numMatches) {
    strike = parseFloat(numMatches[0]);
  }

  return { type, strike, action, sentiment };
}

/**
 * Map a generic unusual-options / flow table into normalized OptionsActivity[].
 * Extracts Feature-3 detail (dte, strike, underlying, OTM%, sweep, vol/OI,
 * premium) when those columns exist, computing them when they don't.
 */
export function mapOptionsTable(
  table: ExtractedTable,
  source: ScraperSource,
  url: string,
): OptionsActivity[] {
  const { headers, rows } = table;
  const idx = {
    ticker: colIndex(headers, ['symbol', 'ticker', 'stock']),
    // 'c/p' before 'type': on InsiderFinance the "Type" header is the ORDER type
    // (SWEEP/BLOCK) while "C/P" is call/put — matching 'type' first read every
    // put as a call.
    type: colIndex(headers, ['c/p', 'call/put', 'put/call', 'side', 'type']),
    premium: colIndex(headers, ['premium', 'notional', 'total premium', 'total value', 'total', 'value']),
    volume: colIndex(headers, ['volume', 'size', 'contracts', 'qty']),
    last: colIndex(
      headers.map((h) => {
        const hl = h.toLowerCase();
        if (hl.includes('last trade') || hl.includes('date')) return '';
        return h;
      }),
      ['latest', 'last', 'fill', 'midpoint', 'option price'],
    ),
    strike: colIndex(headers, ['strike']),
    underlying: colIndex(headers, ['underlying', 'spot', 'stock price', 'ref', 'price']),
    expiry: colIndex(headers, ['exp date', 'expiration', 'expiry', 'exp']),
    dte: colIndex(headers, ['dte', 'days to exp', 'days']),
    oi: colIndex(headers, ['open int', 'open interest', 'oi']),
    voloi: colIndex(headers, ['vol/oi', 'vol / oi', 'v/oi']),
    otm: colIndex(headers, ['otm %', 'otm%', '% otm', 'otm', 'moneyness']),
    // 'type' as last resort so sweep detection still sees InsiderFinance's
    // order-type column after the C/P fix above claims the call/put column.
    order: colIndex(headers, ['trade type', 'order type', 'order', 'flow', 'condition', 'type']),
    sentiment: colIndex(headers, ['sentiment', 'bias']),
    strategy: colIndex(headers, ['strategy', 'details', 'description', 'activity']),
  };

  const out: OptionsActivity[] = [];
  for (const row of rows) {
    // Shape gate — an InsiderFinance grid label ("NVDAEARNINGS") once became a
    // $5.4M "call" and scored 17.3 on a ticker that does not exist.
    const rawTicker = cell(row, idx.ticker);
    if (!isValidTicker(rawTicker)) continue;
    const ticker = canonicalTicker(rawTicker);

    const strategyText = cleanText(cell(row, idx.strategy));
    const stratInfo = strategyText ? parseStrategy(strategyText) : {};

    const typeStr = cleanText(cell(row, idx.type)).toLowerCase();
    let type: 'call' | 'put';
    if (typeStr) {
      type = typeStr.includes('put') || typeStr === 'p' ? 'put' : 'call';
    } else if (stratInfo.type) {
      type = stratInfo.type;
    } else {
      type = 'call';
    }

    const sentRaw = cleanText(cell(row, idx.sentiment)).toLowerCase();
    let sentiment: 'bullish' | 'bearish';
    if (sentRaw.includes('bear')) {
      sentiment = 'bearish';
    } else if (sentRaw.includes('bull')) {
      sentiment = 'bullish';
    } else if (stratInfo.sentiment) {
      sentiment = stratInfo.sentiment;
    } else if (stratInfo.action) {
      if (stratInfo.action === 'buy') {
        sentiment = type === 'put' ? 'bearish' : 'bullish';
      } else {
        sentiment = type === 'put' ? 'bullish' : 'bearish';
      }
    } else {
      sentiment = type === 'put' ? 'bearish' : 'bullish';
    }

    const volume = parseShares(cell(row, idx.volume));
    const last = parseMoney(cell(row, idx.last));
    const openInterest = parseShares(cell(row, idx.oi)) || undefined;
    
    let strike = parseMoney(cell(row, idx.strike)) || undefined;
    if (strike == null && stratInfo.strike != null) {
      strike = stratInfo.strike;
    }

    const underlying = parseMoney(cell(row, idx.underlying)) || undefined;
    const expiry = parseDate(cell(row, idx.expiry)) || undefined;

    let notional = Math.abs(parseMoney(cell(row, idx.premium)));
    if (!notional && volume && last) notional = volume * last * 100;
    if (!notional && !volume) continue;

    // DTE — from a column only when the cell actually holds a number (a blank cell
    // must NOT read as 0, which would falsely earn the short-dated bonus), else from expiry.
    const dteCell = idx.dte >= 0 ? cell(row, idx.dte) : '';
    let dte: number | undefined = /\d/.test(dteCell) ? Math.round(parseMoney(dteCell)) : undefined;
    if ((dte == null || Number.isNaN(dte)) && expiry) {
      const t = Date.parse(expiry);
      if (!Number.isNaN(t)) dte = Math.round((t - Date.now()) / 86_400_000);
    }

    // OTM% — prefer the provider's native column when present (computed at trade time
    // against the real spot, e.g. InsiderFinance), else derive from strike vs underlying.
    // Sign normalized so positive = out-of-the-money for BOTH calls and puts.
    let otmPercent: number | undefined;
    const otmRaw = idx.otm >= 0 ? cleanText(cell(row, idx.otm)) : '';
    const nativeOtm = /\d/.test(otmRaw) ? parseFloat(otmRaw.replace(/[^0-9.\-]/g, '')) : NaN;
    if (Number.isFinite(nativeOtm)) {
      if (strike != null && underlying) {
        const isOtm = type === 'put' ? strike < underlying : strike > underlying;
        otmPercent = (isOtm ? 1 : -1) * Math.abs(nativeOtm);
      } else {
        otmPercent = nativeOtm;
      }
    } else if (strike != null && underlying) {
      const callOtm = ((strike - underlying) / underlying) * 100;
      otmPercent = type === 'put' ? -callOtm : callOtm;
    }

    // Vol/OI — from a column, else computed.
    let volOiRatio: number | undefined = idx.voloi >= 0 ? parseMoney(cell(row, idx.voloi)) : undefined;
    if ((volOiRatio == null || !Number.isFinite(volOiRatio) || volOiRatio === 0) && volume && openInterest) {
      volOiRatio = volume / openInterest;
    }
    volOiRatio =
      volOiRatio != null && Number.isFinite(volOiRatio) && volOiRatio > 0
        ? Math.round(volOiRatio * 100) / 100
        : undefined;

    const orderText = `${cleanText(cell(row, idx.order))} ${typeStr} ${strategyText}`.toLowerCase();
    const isSweep = orderText.includes('sweep');

    out.push({
      ticker,
      type,
      sentiment,
      notional,
      premiumTotal: notional,
      strike,
      currentPrice: underlying,
      otmPercent: otmPercent != null ? Math.round(otmPercent * 10) / 10 : undefined,
      expiry,
      dte: dte != null && Number.isFinite(dte) ? dte : undefined,
      volume: volume || undefined,
      openInterest,
      volOiRatio: volOiRatio || undefined,
      isSweep,
      source,
      sourceUrl: url,
    });
  }
  return out;
}

