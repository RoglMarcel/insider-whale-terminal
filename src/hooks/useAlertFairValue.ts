import { useEffect, useState } from 'react';
import { api } from '@/lib/ipc';
import type { FairValueResult } from '@/types/fairValue';
import { upgradeFairValue } from '@/lib/fairValueDisplay';

const full = new Map<string, { at: number; value: FairValueResult }>();
const requests = new Map<string, Promise<FairValueResult | undefined>>();
let summaries: Promise<Record<string, FairValueResult>> | undefined;
let running = 0;
const queue: (() => void)[] = [];
async function summary() {
  return summaries ??= fetch(`${import.meta.env.BASE_URL}data/analysis-summary.json`, { signal: AbortSignal.timeout(8000) })
    .then(async r => r.ok ? (await r.json()).stocks ?? {} : {}).catch(() => ({}));
}
async function retrieve(ticker: string) {
  const cached = full.get(ticker);
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  if (requests.has(ticker)) return requests.get(ticker)!;
  const task = (async () => {
    if (running >= 2) await new Promise<void>(resolve => queue.push(resolve));
    running++;
    try {
      const value = upgradeFairValue((await api.analysis.analyze(ticker)).valuation);
      full.set(ticker, { value, at: Date.now() });
      return value;
    } catch { return undefined; }
    finally { running--; queue.shift()?.(); }
  })();
  requests.set(ticker, task);
  try { return await task; } finally { requests.delete(ticker); }
}

/** Alert cards share one static summary request; details load the complete analysis. */
export function useAlertFairValue(ticker: string, recorded?: FairValueResult, details = false) {
  const [value, setValue] = useState<FairValueResult | undefined>(() => recorded && upgradeFairValue(recorded));
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    if (!ticker) { setValue(undefined); setLoading(false); return; }
    setValue(recorded && upgradeFairValue(recorded)); setLoading(true);
    void (async () => {
      const snapshot = (await summary())[ticker];
      if (active && snapshot?.fairValue != null && (!recorded?.fairValue || Date.parse(snapshot.calculatedAt) >= Date.parse(recorded.calculatedAt))) setValue(snapshot);
      if (details || !snapshot || snapshot.fairValue == null) {
        const fetched = await retrieve(ticker);
        if (active && fetched && (fetched.fairValue != null || !snapshot) && (!recorded?.fairValue || Date.parse(fetched.calculatedAt) >= Date.parse(recorded.calculatedAt))) setValue(fetched);
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [ticker, recorded, details]);
  return { value, loading };
}
