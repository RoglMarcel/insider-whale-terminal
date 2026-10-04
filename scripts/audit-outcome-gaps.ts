/** Read-only evidence export: exact signals, dates and still-missing horizons.
 * DB_PATH=... AUDIT_OUTPUT=... run the esbuild bundle via run-node-or-electron. */
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, closeDatabase, getOutcomeCandidates, getOutcomeBackfillCandidates, getLabeledKeys } from '../electron/database';

const tickers = 'AAXIA AVB AXIA BK BLL BOTA BT CMIIU COGO EDAP EFCD EIR EKSO ELN GREE ISHC LEI MLPT NRX NUVL RKMIX SPX STWI TE1 TOI USOU'.split(' ');
const horizons = [5, 10, 20, 40, 60, 90, 120, 180];
const cutoff = process.env.AUDIT_CUTOFF ?? '2026-09-25';
const file = process.env.DB_PATH;
if (!file) throw new Error('DB_PATH is required; audit never defaults to a production file');
const db = initDatabase(file, { readonly: true });
try {
  const live = getOutcomeCandidates();
  const seen = new Set(live.map(c => `${c.ticker}|${c.entryDate}`));
  const candidates = [...live, ...getOutcomeBackfillCandidates().filter(c => !seen.has(`${c.ticker}|${c.entryDate}`))];
  const labeled = getLabeledKeys();
  const result = tickers.map(ticker => {
    const signals = db.prepare(`SELECT id, ticker, company_name, scraped_at, trade_date, filing_date,
      source_urls, raw_trades, politician_trades, options_activity FROM signals WHERE ticker=? ORDER BY scraped_at,id`).all(ticker);
    const pending = candidates.filter(c => c.ticker === ticker).map(c => ({ ...c, missing: horizons.flatMap(h => {
      const d = new Date(`${c.entryDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + h);
      const target = d.toISOString().slice(0, 10);
      return target <= cutoff && !labeled.has(`${ticker}|${c.entryDate}|${h}`) ? [{ horizon: h, target }] : [];
    }) })).filter(c => c.missing.length);
    const dates = pending.flatMap(c => [c.entryDate, ...c.missing.map(m => m.target)]).sort();
    return { ticker, signalRows: signals.length, candidatesMissing: pending.length,
      horizonsMissing: pending.reduce((sum, c) => sum + c.missing.length, 0),
      neededFrom: dates[0] ?? null, neededThrough: dates.at(-1) ?? null,
      candidates: pending, signals };
  });
  const output = process.env.AUDIT_OUTPUT ?? 'tmp/outcome-gaps.json';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ cutoff, generatedAt: new Date().toISOString(), tickers: result }, null, 2));
  for (const r of result) console.log(`${r.ticker}: ${r.signalRows} signals; ${r.candidatesMissing} entries / ${r.horizonsMissing} horizons; ${r.neededFrom ?? '-'}..${r.neededThrough ?? '-'}`);
} finally { closeDatabase(); }
