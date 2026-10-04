import { describe, expect, it } from 'vitest';
import { DISCLOSURE_PRICE_CORRECTIONS, PRICE_RENAMES, priceTicker } from '../electron/priceSymbols';

describe('audited historical price identities', () => {
  it.each(DISCLOSURE_PRICE_CORRECTIONS)('matches the exact disclosure for $from, preserving ambiguous uses', r => {
    const identity = { observedDate: '2026-08-16', politicianTrades: [{ politician: 'Ro Khanna', ticker: r.from,
      transactionType: 'buy', tradeDate: r.tradeDate, disclosureDate: r.disclosureDate }] };
    expect(priceTicker(r.from, '2026-09-27', identity)).toBe(r.to);
    expect(priceTicker(r.from, '2026-09-27')).toBe(r.from);
    expect(priceTicker(r.from, '2026-09-27', { ...identity, observedDate: '2025-08-16' })).toBe(r.from);
    expect(priceTicker(r.from, '2026-09-27', { ...identity, politicianTrades: [{ ...identity.politicianTrades[0], tradeDate: '2026-01-01' }] })).toBe(r.from);
  });
  it.each(PRICE_RENAMES)('respects the effective date for $from', r => {
    expect(priceTicker(r.from, r.effectiveDate)).toBe(r.to);
    const before = new Date(Date.parse(r.effectiveDate) - 86400000).toISOString().slice(0, 10);
    expect(priceTicker(r.from, before)).toBe(r.from);
  });
  it('requires a matching issuer and audited date for parser corrections', () => {
    const identity = { observedDate: '2026-08-20', sourceUrls: ['http://www.sec.gov/Archives/edgar/data/1770069/filing.xml'] };
    expect(priceTicker('MLPT', '2026-09-27', identity)).toBe('MPLT');
    expect(priceTicker('MLPT', '2026-09-27')).toBe('MLPT');
    expect(priceTicker('MLPT', '2026-09-27', { ...identity, observedDate: '2025-08-20' })).toBe('MLPT');
    expect(priceTicker('MLPT', '2026-09-27', { ...identity, sourceUrls: ['https://example.org/data/1770069/'] })).toBe('MLPT');
    expect(priceTicker('NRX', '2026-09-27', { observedDate: '2026-08-15', sourceUrls: ['https://www.secform4.com/filings/1933567/0001437749-26-004101.htm'] })).toBe('NRXS');
  });
  it.each(['AVB', 'NUVL', 'AXIA', 'CMIIU', 'RKMIX', 'SPX', 'TE1', 'AAXIA'])('does not replace unresolved %s with a different security', t => {
    expect(priceTicker(t, '2026-09-27')).toBe(t);
  });
});
