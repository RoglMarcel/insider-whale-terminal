import type { VixQuote } from '../src/types';

/**
 * Feature 8 — CBOE Volatility Index (VIX). Primary source is CBOE's own public
 * delayed-quote JSON (the index publisher — the most stable endpoint there is);
 * Yahoo Finance's unofficial chart API remains as fallback. Fetched on app
 * start and every 15 minutes; cached for synchronous reads.
 */
const CBOE_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json';
const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** A stale multiplier is worse than none: past this age scoring omits VIX (→ ×1.0). */
const VIX_MAX_AGE_MS = 2 * 60 * 60 * 1000;

let cached: VixQuote | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function getCachedVix(): VixQuote | null {
  if (!cached) return null;
  const age = Date.now() - Date.parse(cached.timestamp);
  if (Number.isNaN(age) || age > VIX_MAX_AGE_MS) return null;
  return cached;
}

export function vixLevel(value: number): VixQuote['level'] {
  // Bands aligned with the scoring ramp (getVixMultiplier boosts from VIX 20):
  // the UI must never say "normal" while scores are silently being boosted.
  if (value < 15) return 'low';
  if (value <= 20) return 'normal';
  return 'high';
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchVix(): Promise<VixQuote | null> {
  let price: number | undefined;

  const cboe = await fetchJson(CBOE_URL);
  const cboePrice = cboe?.data?.current_price;
  if (typeof cboePrice === 'number' && Number.isFinite(cboePrice) && cboePrice > 0) {
    price = cboePrice;
  } else {
    const yahoo = await fetchJson(YAHOO_URL);
    const p = yahoo?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (typeof p === 'number' && Number.isFinite(p)) price = p;
  }

  if (price == null) return getCachedVix();
  cached = {
    value: Math.round(price * 100) / 100,
    level: vixLevel(price),
    timestamp: new Date().toISOString(),
  };
  return cached;
}

/** Start polling VIX every 15 minutes (fires once immediately). */
export function startVixPolling(onUpdate?: (quote: VixQuote) => void): void {
  const tick = async () => {
    const q = await fetchVix();
    if (q && onUpdate) onUpdate(q);
  };
  void tick();
  timer = setInterval(() => void tick(), 15 * 60 * 1000);
}

export function stopVixPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
