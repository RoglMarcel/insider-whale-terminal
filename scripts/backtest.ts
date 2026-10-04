/*
 * Backtest / calibration — replays the stored signals against realized forward
 * returns to check whether higher conviction scores actually precede better
 * outcomes (and by how much vs the market). Read-only against the live DB.
 *
 * Run:  npm run backtest            (auto-locates the app DB)
 *       BACKTEST_DB=/path/to.db npm run backtest
 *
 * Needs Electron's ABI for better-sqlite3 (invoked via `electron`, like verify:db)
 * and network access for Yahoo price history.
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import Database from 'better-sqlite3';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HORIZONS = [30, 90]; // calendar days forward

interface Row {
  id: number;
  ticker: string;
  score: number;
  conviction_level: string | null;
  scraped_at: string;
  trade_date: string | null;
}

async function fetchAdjClose(symbol: string): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return map;
    const result = ((await res.json()) as any)?.chart?.result?.[0];
    const ts: number[] = result?.timestamp || [];
    const adj: number[] = result?.indicators?.adjclose?.[0]?.adjclose || result?.indicators?.quote?.[0]?.close || [];
    ts.forEach((t, i) => {
      const v = adj[i];
      if (v != null && Number.isFinite(v)) map[new Date(t * 1000).toISOString().slice(0, 10)] = v;
    });
  } catch {
    /* leave empty */
  }
  return map;
}

function priceNear(map: Record<string, number>, dateStr: string, offsetDays = 0): number | undefined {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + offsetDays);
  if (d > new Date()) return undefined;
  for (let i = 0; i < 6; i++) {
    const s = d.toISOString().slice(0, 10);
    if (map[s] != null) return map[s];
    d.setDate(d.getDate() + 1);
  }
  return undefined;
}

function pct(later: number | undefined, basis: number | undefined): number | undefined {
  if (later == null || basis == null || basis === 0) return undefined;
  return ((later - basis) / basis) * 100;
}

function stats(xs: number[]) {
  if (!xs.length) return { n: 0, avg: 0, med: 0, winRate: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: xs.length,
    avg: xs.reduce((a, b) => a + b, 0) / xs.length,
    med: s[Math.floor(s.length / 2)],
    winRate: xs.filter((x) => x > 0).length / xs.length,
  };
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

function row(label: string, r: ReturnType<typeof stats>, a: ReturnType<typeof stats>): string {
  return `  ${label.padEnd(12)} n=${String(r.n).padStart(4)}  avgRet=${r.avg.toFixed(1).padStart(6)}%  ` +
    `win=${(r.winRate * 100).toFixed(0).padStart(3)}%  avgAlpha=${a.avg.toFixed(1).padStart(6)}%  ` +
    `beatMkt=${(a.winRate * 100).toFixed(0).padStart(3)}%`;
}

(async () => {
  const candidates = [
    process.env.BACKTEST_DB,
    path.join(app.getPath('appData'), 'Insider & Whale Terminal', 'insider-tracker.db'),
    path.join(app.getPath('appData'), 'insider-whale-terminal', 'insider-tracker.db'),
    path.join(app.getPath('userData'), 'insider-tracker.db'),
  ].filter(Boolean) as string[];
  const dbPath = candidates.find((p) => fs.existsSync(p));
  if (!dbPath) {
    console.error('No insider-tracker.db found. Set BACKTEST_DB=<path>. Tried:\n' + candidates.join('\n'));
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, ticker, score, conviction_level, scraped_at, trade_date, filing_date FROM signals ORDER BY scraped_at ASC`,
    )
    .all() as (Row & { filing_date?: string | null })[];
  console.log(`DB: ${dbPath}\nLoaded ${rows.length} stored signals.\n`);

  const maxH = Math.max(...HORIZONS);
  const ripe = rows.filter((r) => {
    const t = Date.parse(r.scraped_at);
    return !Number.isNaN(t) && (Date.now() - t) / 86_400_000 >= maxH + 3;
  });
  if (!ripe.length) {
    console.log(`No signals are old enough (need ≥ ${maxH} days) to have realized outcomes yet. Re-run later.`);
    db.close();
    process.exit(0);
  }

  // One observation per (ticker, entry date): the same ticker is re-scraped
  // 3×/day, and those near-identical overlapping windows are not independent
  // samples — they inflate n and wash out the score↔alpha correlation. Keep the
  // FIRST session's score (the earliest actionable decision point; `ripe` is
  // already ordered scraped_at ASC).
  // Entry = max(trade, filing, first-seen) — never pure trade date alone.
  const entryDateOf = (r: Row & { filing_date?: string | null }) => {
    const cands: string[] = [];
    if (r.trade_date && /^\d{4}-\d{2}-\d{2}$/.test(r.trade_date)) cands.push(r.trade_date);
    if (r.filing_date && /^\d{4}-\d{2}-\d{2}$/.test(r.filing_date)) cands.push(r.filing_date);
    const scraped = r.scraped_at.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(scraped)) cands.push(scraped);
    return cands.length ? cands.sort().slice(-1)[0] : scraped;
  };
  const seenEntries = new Set<string>();
  const deduped = ripe.filter((r) => {
    const key = `${r.ticker}|${entryDateOf(r)}`;
    if (seenEntries.has(key)) return false;
    seenEntries.add(key);
    return true;
  });
  console.log(`Deduped ${ripe.length} ripe signals → ${deduped.length} unique (ticker, entry-date) observations.`);

  const tickers = [...new Set(deduped.map((r) => r.ticker))];
  console.log(`Fetching ${tickers.length} tickers + SPY from Yahoo…`);
  const spy = await fetchAdjClose('SPY');
  const priceMaps: Record<string, Record<string, number>> = {};
  for (let i = 0; i < tickers.length; i++) {
    priceMaps[tickers[i]] = await fetchAdjClose(tickers[i]);
    if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${tickers.length}`);
  }

  type Outcome = { score: number; tier: string; ret: number; alpha: number };
  const byHorizon: Record<number, Outcome[]> = {};
  for (const h of HORIZONS) byHorizon[h] = [];

  for (const r of deduped) {
    const map = priceMaps[r.ticker];
    if (!map || Object.keys(map).length === 0) continue;
    const entryDate = entryDateOf(r);
    const basis = priceNear(map, entryDate, 0);
    if (basis == null) continue;
    const spyBasis = priceNear(spy, entryDate, 0);
    for (const h of HORIZONS) {
      const ret = pct(priceNear(map, entryDate, h), basis);
      if (ret == null) continue;
      const spyRet = pct(priceNear(spy, entryDate, h), spyBasis) ?? 0;
      byHorizon[h].push({ score: r.score, tier: r.conviction_level || 'LOW', ret, alpha: ret - spyRet });
    }
  }

  for (const h of HORIZONS) {
    const data = byHorizon[h];
    console.log(`\n══ ${h}-day forward outcomes (n=${data.length}) ══`);
    if (!data.length) {
      console.log('  (no usable outcomes)');
      continue;
    }
    for (const tier of ['HIGH', 'WATCH', 'LOW']) {
      const d = data.filter((o) => o.tier === tier);
      if (d.length) console.log(row(tier, stats(d.map((o) => o.ret)), stats(d.map((o) => o.alpha))));
    }
    console.log('  — by score bucket —');
    const buckets: Array<[string, (s: number) => boolean]> = [
      ['0–25', (s) => s < 25],
      ['25–50', (s) => s >= 25 && s < 50],
      ['50–70', (s) => s >= 50 && s < 70],
      ['70–85', (s) => s >= 70 && s < 85],
      ['85+', (s) => s >= 85],
    ];
    for (const [label, fn] of buckets) {
      const d = data.filter((o) => fn(o.score));
      if (d.length) console.log(row(`score ${label}`, stats(d.map((o) => o.ret)), stats(d.map((o) => o.alpha))));
    }
    const corr = pearson(data.map((o) => o.score), data.map((o) => o.alpha));
    const verdict = corr > 0.05 ? 'higher scores → more alpha ✓' : corr < -0.05 ? 'INVERTED — score anti-predictive ✗' : 'flat — score not yet predictive';
    console.log(`  score ↔ alpha correlation: ${corr.toFixed(3)}  (${verdict})`);
  }

  console.log('\nNote: alpha = realized return minus the S&P 500 over the same window (split/dividend-adjusted).');
  db.close();
  process.exit(0);
})();
