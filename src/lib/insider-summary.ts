import { classifyTransaction, normalizeInsiderName, type RawInsiderTrade } from '../types';
import { admissibleTrade } from './tradeEligibility';
import { sanitizeTradeAmounts } from '../../electron/scraper/util';

/** Display activity separately from the purchase-only conviction score. */
export function summarizeInsiderTrades(trades: RawInsiderTrade[], now = Date.now(), days?: number) {
  const rows = trades.filter(t => admissibleTrade(t, days, now)).flatMap(t => {
    const amounts = sanitizeTradeAmounts(t.shares, t.price, t.value);
    return amounts ? [{ ...t, ...amounts }] : [];
  });
  const buys = rows.filter(t => classifyTransaction(t.transactionType).modifier > 0);
  const sales = rows.filter(t => /sale/i.test(classifyTransaction(t.transactionType).label)
    && classifyTransaction(t.transactionType).tier === 'excluded');
  const volume = (items: RawInsiderTrade[]) => items.reduce((sum, t) => sum + t.value, 0);
  const average = (items: RawInsiderTrade[]) => {
    const priced = items.filter(t => t.shares > 0 && t.price != null && t.price > 0);
    const shares = priced.reduce((sum, t) => sum + t.shares, 0);
    return shares > 0 ? priced.reduce((sum, t) => sum + t.price! * t.shares, 0) / shares : undefined;
  };
  const latest = [...rows].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))[0];
  const display = buys.length ? buys : sales.length ? sales : rows;
  return {
    count: new Set(rows.map(t => normalizeInsiderName(t.insiderName)).filter(Boolean)).size,
    buys: volume(buys), sells: volume(sales),
    buyPrice: average(buys), salePrice: average(sales),
    saleOnly: buys.length === 0 && sales.length > 0,
    role: [...display].sort((a, b) => b.value - a.value).find(t => t.role?.trim())?.role || '—',
    tradeDate: latest?.tradeDate, filingDate: latest?.filingDate,
  };
}

/** Feeds overlap: use the best covered sale total, never sum overlapping feeds. */
export function mergeInsiderSaleVolume(feedSales: number, recordedSales: number): number {
  return Math.max(Number.isFinite(feedSales) ? feedSales : 0, Number.isFinite(recordedSales) ? recordedSales : 0, 0);
}
