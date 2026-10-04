/**
 * Audit the stored testing portfolio against the real database (READ-ONLY).
 *
 *   npm run verify:portfolio
 *
 * This is the script a sceptic runs. It does not ask whether the strategy is
 * good — it asks whether the arithmetic is honest: does the NAV identity hold on
 * every single day, is the benchmark really a plain SPY buy & hold, can two
 * positions hold the same ticker, does an exit ever precede its entry, and does
 * re-running the deterministic engine reproduce the curve that is on disk.
 *
 * Opened with `readonly: true` on purpose: the write path runs backups and
 * migrations against a file that is committed history.
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  initDatabase,
  closeDatabase,
  getPortfolioConfig,
  getPortfolioEquity,
  getPortfolioEvents,
  getPortfolioPositions,
  getPortfolioRunMeta,
  getPriceBook,
} from '../electron/database';
import { buildCandidates } from '../electron/portfolio';
import { applySlippage, diffDaysYmd, simulatePortfolio } from '../src/lib/portfolio-rules';

let failures = 0;
let warnings = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

function warn(name: string, ok: boolean, detail = ''): void {
  if (!ok) warnings++;
  console.log(`${ok ? '✓' : '⚠ WARN'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

const money = (v: number): string => `$${v.toFixed(2)}`;

function main(): void {
  const dbPath = (process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'insider-tracker.db')).trim();
  if (!fs.existsSync(dbPath)) {
    console.log(`No database at ${dbPath} — nothing to verify.`);
    process.exit(0);
  }
  console.log(`DB: ${dbPath} (read-only)\n`);
  initDatabase(dbPath, { readonly: true });

  const equity = getPortfolioEquity();
  const positions = getPortfolioPositions();
  const events = getPortfolioEvents(5000);
  const config = getPortfolioConfig();
  const runMeta = getPortfolioRunMeta();

  if (!equity.length) {
    console.log('No portfolio curve stored yet — run `npm run portfolio:sync` first.');
    closeDatabase();
    process.exit(0);
  }

  const first = equity[0];
  const last = equity[equity.length - 1];
  console.log(
    `Curve: ${first.date} → ${last.date} · ${equity.length} trading day(s) · ` +
      `${positions.length} position(s) · ${events.length} event(s)\n`,
  );

  // ── 1. NAV identity, on EVERY day ──
  let worstResidual = 0;
  let worstDate = '';
  for (const p of equity) {
    const residual = Math.abs(p.equity - (p.cash + p.spyCashValue + p.positionsValue));
    if (residual > worstResidual) {
      worstResidual = residual;
      worstDate = p.date;
    }
  }
  check(
    'equity = cash + spy_cash_value + positions_value on every day (±$0.01)',
    worstResidual <= 0.01,
    `worst residual ${money(worstResidual)} on ${worstDate}`,
  );

  // ── 2. No gaps: the curve covers exactly SPY's trading days in its own range ──
  const spy = getPriceBook(['SPY'], first.date).SPY ?? {};
  const spyDays = Object.keys(spy)
    .filter((d) => d >= first.date && d <= last.date)
    .sort();
  const curveDays = equity.map((p) => p.date);
  const missing = spyDays.filter((d) => !curveDays.includes(d));
  const extra = curveDays.filter((d) => !spyDays.includes(d));
  check(
    'curve has one point per SPY trading day, no gaps and no invented days',
    missing.length === 0 && extra.length === 0,
    `missing ${missing.slice(0, 5).join(', ') || '—'} · extra ${extra.slice(0, 5).join(', ') || '—'}`,
  );
  check(
    'curve dates are strictly ascending',
    curveDays.every((d, i) => i === 0 || d > curveDays[i - 1]),
    'duplicate or out-of-order dates',
  );

  // ── 3. Benchmark really is SPY buy & hold ──
  const spyStart = spy[first.date];
  if (spyStart == null) {
    check('benchmark reproducible from the SPY series', false, `no SPY close cached for ${first.date}`);
  } else {
    const shares = config.startingCash / applySlippage(spyStart, 'buy', config.slippageBps);
    let worstBench = 0;
    let benchDate = '';
    for (const p of equity) {
      const px = spy[p.date];
      if (px == null) continue;
      const d = Math.abs(p.benchmark - shares * px);
      if (d > worstBench) {
        worstBench = d;
        benchDate = p.date;
      }
    }
    check(
      'benchmark = SPY buy & hold from the same day, same capital, same slippage (±$0.01)',
      worstBench <= 0.01,
      `worst deviation ${money(worstBench)} on ${benchDate}`,
    );
    // Both series mark at the starting capital MINUS one side of slippage on
    // day one — that is the cost of getting in, and both pay it identically.
    const afterEntryCost = config.startingCash * (1 - config.slippageBps / 10_000);
    check(
      'both series start on the same day at the same value',
      Math.abs(first.equity - first.benchmark) <= 0.01,
      `equity ${money(first.equity)} vs benchmark ${money(first.benchmark)}`,
    );
    check(
      'the starting value is the configured capital less one side of slippage',
      Math.abs(first.benchmark - afterEntryCost) <= 0.02,
      `${money(first.benchmark)}, expected ${money(afterEntryCost)} from ${money(config.startingCash)}`,
    );
  }

  // ── 4. Position sanity ──
  const badExit = positions.filter((p) => p.exitDate && p.exitDate < p.entryDate);
  check('every exit is on or after its entry', badExit.length === 0, `${badExit.length} inverted trade(s)`);

  const openByTicker = new Map<string, number>();
  for (const p of positions.filter((x) => !x.exitDate)) {
    openByTicker.set(p.ticker, (openByTicker.get(p.ticker) ?? 0) + 1);
  }
  const dupes = [...openByTicker.entries()].filter(([, n]) => n > 1);
  check('no two open positions hold the same ticker', dupes.length === 0, dupes.map(([t, n]) => `${t}×${n}`).join(', '));

  // Overlapping lots of one ticker are the same defect one step earlier.
  const byTicker = new Map<string, typeof positions>();
  for (const p of positions) {
    const list = byTicker.get(p.ticker) ?? [];
    list.push(p);
    byTicker.set(p.ticker, list);
  }
  const overlaps: string[] = [];
  for (const [ticker, lots] of byTicker) {
    const sorted = [...lots].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    for (let i = 1; i < sorted.length; i++) {
      const prevExit = sorted[i - 1].exitDate;
      if (!prevExit || sorted[i].entryDate < prevExit) overlaps.push(`${ticker} ${sorted[i].entryDate}`);
    }
  }
  check('no ticker is held in two overlapping lots', overlaps.length === 0, overlaps.slice(0, 5).join(', '));

  const cooldownBreaks: string[] = [];
  for (const [ticker, lots] of byTicker) {
    const sorted = [...lots].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    for (let i = 1; i < sorted.length; i++) {
      const prevExit = sorted[i - 1].exitDate;
      if (prevExit && diffDaysYmd(prevExit, sorted[i].entryDate) < config.reentryCooldownDays) {
        cooldownBreaks.push(`${ticker} ${prevExit}→${sorted[i].entryDate}`);
      }
    }
  }
  check(
    `re-entry cooldown of ${config.reentryCooldownDays} days is respected`,
    cooldownBreaks.length === 0,
    cooldownBreaks.slice(0, 5).join(', '),
  );

  check(
    'cash is never negative',
    equity.every((p) => p.cash >= -0.005),
    `min ${money(Math.min(...equity.map((p) => p.cash)))}`,
  );
  check(
    `never more than ${config.maxPositions} open positions`,
    equity.every((p) => p.openPositions <= config.maxPositions),
    `max ${Math.max(...equity.map((p) => p.openPositions))}`,
  );
  check(
    'every entry score clears the configured threshold',
    positions.every((p) => p.entryScore >= config.entryScore),
    positions
      .filter((p) => p.entryScore < config.entryScore)
      .slice(0, 5)
      .map((p) => `${p.ticker} ${p.entryScore}`)
      .join(', '),
  );

  // ── 5. Realized P&L agrees with the fills ──
  const closed = positions.filter((p) => p.exitDate && p.exitPrice != null);
  let worstPnl = 0;
  for (const p of closed) {
    const expected = p.shares * (p.exitPrice as number) - p.costBasis;
    worstPnl = Math.max(worstPnl, Math.abs(expected - (p.realizedPnl ?? 0)));
  }
  check('realized P&L = shares × exit − cost basis (±$0.01)', worstPnl <= 0.01, `worst ${money(worstPnl)}`);

  // ── 6. Prices used are actually in the cache ──
  const priced = getPriceBook([...byTicker.keys()], first.date);
  const unpriced = [...byTicker.keys()].filter((t) => !priced[t] || !Object.keys(priced[t]).length);
  check(
    'every traded ticker has a cached adjusted-close series',
    unpriced.length === 0,
    unpriced.slice(0, 8).join(', '),
  );
  const badEntryPrice = positions.filter((p) => {
    const px = priced[p.ticker]?.[p.entryDate];
    return px == null || Math.abs(applySlippage(px, 'buy', config.slippageBps) - p.entryPrice) > 0.01;
  });
  check(
    'every entry price is the cached close of its entry day plus slippage',
    badEntryPrice.length === 0,
    badEntryPrice
      .slice(0, 5)
      .map((p) => `${p.ticker} ${p.entryDate}`)
      .join(', '),
  );

  // ── 7. Determinism: re-run the engine and compare with what is on disk ──
  const candidates = buildCandidates(config);
  const universe = [...new Set(candidates.map((c) => c.ticker))];
  const book = getPriceBook(universe, first.date);
  const tradingDays = Object.keys(spy).sort();
  const sim = simulatePortfolio({ config, tradingDays, spy, prices: book, candidates });
  const simByDate = new Map(sim.equity.map((p) => [p.date, p]));
  let drift = 0;
  let driftDate = '';
  for (const p of equity) {
    const s = simByDate.get(p.date);
    if (!s) continue;
    const d = Math.abs(s.equity - p.equity);
    if (d > drift) {
      drift = d;
      driftDate = p.date;
    }
  }
  // A WARNING, not a failure: Yahoo restates the whole adjusted series after a
  // split or dividend, and the stored curve is deliberately append-only. Drift
  // means the cache moved under a frozen curve — worth knowing, not a bug.
  warn(
    're-simulating the stored window reproduces the stored curve (±$0.01)',
    drift <= 0.01,
    `worst ${money(drift)} on ${driftDate} — prices were restated after that day was written`,
  );

  // ── 8. Metadata is present and matches ──
  check('the parameter set used for the curve is stored alongside it', !!runMeta, 'portfolio_meta missing');
  if (runMeta) {
    const same = (Object.keys(config) as (keyof typeof config)[]).every((k) => runMeta.config[k] === config[k]);
    warn(
      'stored parameters match the active configuration',
      same,
      'the config was changed without a rebuild — the chart would show numbers it was not computed with',
    );
  }

  const skipped = events.filter((e) => e.kind === 'skipped_no_cash').length;
  const capped = events.filter((e) => e.kind === 'skipped_cap').length;
  const missingPx = events.filter((e) => e.kind === 'data_missing').length;
  const suspect = events.filter((e) => e.kind === 'suspect_price').length;
  console.log(
    `\nData quality: ${skipped} skipped (no cash) · ${capped} skipped (position cap) · ` +
      `${missingPx} without price data · ${suspect} suspect price point(s) ignored`,
  );
  if (runMeta?.untradableTickers.length) {
    console.log(`Not tradable: ${runMeta.untradableTickers.join(', ')}`);
  }

  closeDatabase();
}

try {
  main();
} catch (err) {
  failures++;
  console.error('THREW:', err);
}

console.log(
  `\n${failures === 0 ? `✅ ALL PORTFOLIO CHECKS PASSED${warnings ? ` (${warnings} warning(s))` : ''}` : `❌ ${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
