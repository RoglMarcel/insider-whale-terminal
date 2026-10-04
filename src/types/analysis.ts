import type { FairValueResult } from './fairValue';

export interface StockAnalysis {
  ticker: string;
  valuation: FairValueResult;
  origin: 'live' | 'snapshot' | 'scheduled';
}

export interface StockSuggestion { ticker: string; name: string; exchange: string }

export function normalizeAnalysisTicker(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Bitte ein gültiges Börsenkürzel eingeben.');
  const ticker = input.trim().replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || ticker.includes('..')) throw new Error('Bitte ein Börsenkürzel eingeben, z. B. AAPL, SAP.DE oder 7203.T.');
  return ticker;
}
