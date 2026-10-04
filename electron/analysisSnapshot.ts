import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { StockAnalysis } from '../src/types/analysis';
import { upgradeFairValue } from '../src/lib/fairValueDisplay';

let cached: { file: string; mtime: number; results: Record<string, StockAnalysis> } | undefined;
/** Scheduled data also supplies alert enrichment and desktop outage recovery. */
export function getAnalysisSnapshot(ticker: string): StockAnalysis | undefined {
  const resources = (process as NodeJS.Process & {resourcesPath?: string}).resourcesPath;
  const candidates = [path.resolve('data/analysis-cache.json.gz'), ...(resources ? [path.join(resources,'app.asar','dist','data','analysis-cache.json.gz')] : [])];
  for (const file of candidates) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!cached || cached.file !== file || cached.mtime !== mtime) cached = { file, mtime, results: JSON.parse(gunzipSync(fs.readFileSync(file)).toString()).results };
      const found = cached.results[ticker];
      if (!found || !found.valuation || found.valuation.fairValue == null) continue;
      const valuation = upgradeFairValue(found.valuation);
      if (Date.now() - Date.parse(valuation.calculatedAt) > 86_400_000) {
        return { ...found, valuation: { ...valuation, weight: 0, multiplier: 1, recommendation:'insufficient-data' }, origin:'snapshot' };
      }
      return { ...found, valuation, origin:'snapshot' };
    } catch { /* optional cache; live sources remain available */ }
  }
}
