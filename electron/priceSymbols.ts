/** Verified provider identities. These rules never rewrite stored signals or
 * substitute an acquirer's stock for a delisted security. */
export const PRICE_RENAMES = [
  { from: 'GREE', to: 'VIP', effectiveDate: '2026-07-24', source: 'https://www.sec.gov/Archives/edgar/data/1844971/000162828026057159/gree-20260630.htm' },
  { from: 'EDAP', to: 'FOCL', effectiveDate: '2026-06-01', source: 'https://www.sec.gov/Archives/edgar/data/1041934/000117184326003773/exh_991.htm' },
  { from: 'BK', to: 'BNY', effectiveDate: '2026-05-21', source: 'https://www.bny.com/corporate/global/en/about-us/newsroom/press-release/bny-announces-planned-change-of-stock-ticker-symbol-to-bny-130465.html' },
  { from: 'BLL', to: 'BALL', effectiveDate: '2022-05-10', source: 'https://www.ball.com/newswire/article/124123/ball-board-declares-quarterly-dividend-stock-ticker-symbol-changing-to-ball' },
  { from: 'TOI', to: 'STLN', effectiveDate: '2026-08-04', source: 'https://investors.starlingoncology.com/' },
  { from: 'EKSO', to: 'CHRN', effectiveDate: '2026-05-05', source: 'https://ir.chronoscale.com/press-releases/detail/789/applied-digital-completes-separation-of-cloud-business' },
] as const;

export interface PriceIdentity {
  companyName?: string | null;
  sourceUrls?: string[];
  observedDate?: string;
  politicianTrades?: { politician: string; ticker: string; tradeDate: string; disclosureDate: string; transactionType: string }[];
}

/** Exact disclosed trades matched against the source's issuer description,
 * then the issuer's own listing. Never a global rename of these ambiguous codes. */
export const DISCLOSURE_PRICE_CORRECTIONS = [
  { from: 'COGO', to: 'COO', tradeDate: '2026-06-23', disclosureDate: '2026-07-06', source: 'https://www.quiverquant.com/congresstrading/stock/COGO', listing: 'https://investor.coopercos.com/investor-relations' },
  { from: 'EIR', to: 'CMPGY', tradeDate: '2026-06-12', disclosureDate: '2026-07-06', source: 'https://www.quiverquant.com/congresstrading/stock/EIR', listing: 'https://www.compass-group.com/en/investors/adr.html' },
  { from: 'ISHC', to: 'EWJ', tradeDate: '2026-07-10', disclosureDate: '2026-08-07', source: 'https://www.quiverquant.com/congresstrading/stock/ISHC', listing: 'https://www.ishares.com/us/products/239665/ishares-msci-japan-etf' },
] as const;

/** Parser/source mistakes are bounded to audited observations AND issuer CIK.
 * NRX on a different exchange, for example, must not become Neuraxis. */
export const PRICE_CORRECTIONS = [
  { from: 'MLPT', to: 'MPLT', cik: '1770069', fromDate: '2026-08-19', toDate: '2026-09-11', source: 'https://ir.maplightrx.com/news-events/news-releases' },
  { from: 'NRX', to: 'NRXS', cik: '1933567', fromDate: '2026-08-15', toDate: '2026-08-16', source: 'https://www.sec.gov/Archives/edgar/data/1933567/000149315226019380/formars.pdf' },
] as const;

export function priceTicker(symbol: string, asOf: string, identity?: PriceIdentity): string {
  const renamed = PRICE_RENAMES.find(r => r.from === symbol && asOf >= r.effectiveDate);
  if (renamed) return renamed.to;
  const disclosure = DISCLOSURE_PRICE_CORRECTIONS.find(r => r.from === symbol && identity?.observedDate &&
    identity.observedDate >= '2026-08-15' && identity.observedDate <= '2026-08-22' &&
    identity.politicianTrades?.length && identity.politicianTrades.every(t =>
      t.ticker === r.from && t.politician === 'Ro Khanna' && t.transactionType === 'buy' &&
      t.tradeDate === r.tradeDate && t.disclosureDate === r.disclosureDate));
  if (disclosure) return disclosure.to;
  const correction = PRICE_CORRECTIONS.find(r => r.from === symbol && identity?.observedDate &&
    identity.observedDate >= r.fromDate && identity.observedDate <= r.toDate &&
    identity.sourceUrls?.some(url => {
      try {
        const u = new URL(url);
        return ((u.hostname === 'www.sec.gov' || u.hostname === 'sec.gov') && u.pathname.includes(`/data/${r.cik}/`)) ||
          (u.hostname === 'www.secform4.com' && u.pathname.includes(`/filings/${r.cik}/`));
      } catch { return false; }
    }));
  return correction?.to ?? symbol;
}
