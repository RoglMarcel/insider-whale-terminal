import {
  DEFAULT_PORTFOLIO_CONFIG,
  PORTFOLIO_MIN_DAYS_CAGR,
  PORTFOLIO_MIN_DAYS_SHARPE,
  PORTFOLIO_PRICE_SEARCH_DAYS,
  PORTFOLIO_SESSION_CLOSE_UTC_HOUR,
  PORTFOLIO_SIGMA_LOOKBACK_DAYS,
  PORTFOLIO_TRADING_DAYS_PER_CALENDAR_DAY,
  PORTFOLIO_WINDOWS,
  type PortfolioCandidate,
  type PortfolioCashPolicy,
  type PortfolioClosedPosition,
  type PortfolioConfig,
  type PortfolioEquityPoint,
  type PortfolioEvent,
  type PortfolioExitReason,
  type PortfolioMetric,
  type PortfolioOpenPosition,
  type PortfolioPosition,
  type PortfolioState,
  type PortfolioStats,
  type PortfolioTradeStats,
  type PortfolioWindowStat,
  // Relative, not the '@' alias: this module is bundled by esbuild for the CLI
  // scripts and typechecked under tsconfig.node.json, neither of which knows it.
} from '../types';

/**
 * The testing portfolio's RULES — pure, dependency-free, fully testable.
 *
 * Everything that touches SQLite, Yahoo or Electron lives in `electron/portfolio.ts`;
 * this file only turns (config + trading calendar + prices + candidate signals)
 * into (equity curve + trades + events). That split is what makes the two claims
 * the whole feature rests on checkable by a unit test rather than by inspection:
 * no look-ahead (an entry can never price before its signal was visible), and
 * determinism (the same inputs produce a byte-identical curve).
 */

// ── UTC calendar math (never local time — a date-only string parsed as local
//    midnight shifts by the machine's offset and moves every hold-day count) ──

export function ymdToUtcMs(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * 86_400_000).toISOString().slice(0, 10);
}

export function diffDaysYmd(from: string, to: string): number {
  return Math.round((ymdToUtcMs(to) - ymdToUtcMs(from)) / 86_400_000);
}

/**
 * Earliest calendar date whose CLOSING auction was still ahead of `seenAt`.
 *
 * This is the entire no-look-ahead guarantee in one function. A signal first
 * seen at 23:07 UTC could not have been bought at that day's close, which had
 * already happened — it prices at the NEXT session. The hour is read out of the
 * string rather than through `Date.parse`, because SQLite also writes
 * `YYYY-MM-DD HH:MM:SS` (UTC, no zone marker) and Node would parse that as
 * LOCAL time, silently shifting the cutoff by the machine's offset.
 */
export function earliestEntryDate(
  seenAt: string,
  closeUtcHour: number = PORTFOLIO_SESSION_CLOSE_UTC_HOUR,
): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2})/.exec(String(seenAt).trim());
  if (!m) return String(seenAt).slice(0, 10);
  return Number(m[2]) >= closeUtcHour ? addDaysYmd(m[1], 1) : m[1];
}

// ── Trading mechanics ──

/** Fills are worse than the close on BOTH sides — never in the book's favour. */
export function applySlippage(price: number, side: 'buy' | 'sell', slippageBps: number): number {
  const f = slippageBps / 10_000;
  return side === 'buy' ? price * (1 + f) : price * (1 - f);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Barrier comparisons need a tolerance. `120 / 100 - 1` is 0.19999999999999996
 * in IEEE-754, so a position sitting EXACTLY on the +20% target would not take
 * profit — and the same slip hides the −10% stop and the +15% trailing arm. The
 * tolerance is far below any price move that could matter.
 */
const BARRIER_EPS = 1e-9;

export interface PositionSizing {
  targetWeight: number;
  value: number;
}

/**
 * Higher score → bigger position. The span is anchored on the CONFIGURED entry
 * score, not on a literal 74, so a sweep that lowers the threshold still starts
 * every qualifying signal at the base weight instead of at the floor.
 */
export function positionSize(
  score: number,
  equity: number,
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG,
): PositionSizing {
  if (!(score >= config.entryScore)) return { targetWeight: 0, value: 0 };
  const scoreFactor = 1 + (score - config.entryScore) / config.scoreSpan;
  const targetWeight = clamp(config.baseWeight * scoreFactor, config.minWeight, config.maxWeight);
  return { targetWeight, value: Math.max(0, equity) * targetWeight };
}

export interface ExitContext {
  entryPrice: number;
  /** Today's adjusted close. */
  close: number;
  /** Highest adjusted close since entry, today's included. */
  highWaterClose: number;
  /** Calendar days held. */
  holdDays: number;
  /**
   * Realised DAILY log-return volatility over the window ending on the entry
   * day — fixed at entry, never re-estimated, so a scaled barrier is a static
   * level and not a line that walks around under the position.
   *
   * Only read when `config.sigmaBarriers` is set; `null` there means "no usable
   * estimate", which falls back to the fixed percentages.
   */
  sigmaDaily?: number | null;
}

/**
 * Realised daily volatility of a close series over the last `lookback` points at
 * or before `asOf`. Sample standard deviation of LOG returns — log rather than
 * simple, because the barrier it feeds is a multiplicative distance.
 *
 * Returns `null`, never 0, when the history is too thin: a zero sigma would
 * collapse every scaled barrier onto the entry price and stop the position out
 * on its first tick.
 */
export function realizedDailyVol(
  series: Record<string, number> | undefined,
  asOf: string,
  lookback: number = PORTFOLIO_SIGMA_LOOKBACK_DAYS,
): number | null {
  if (!series) return null;
  const closes: number[] = [];
  for (const d of Object.keys(series).sort()) {
    if (d > asOf) break;
    const px = series[d];
    if (px != null && px > 0) closes.push(px);
  }
  const window = closes.slice(-(lookback + 1));
  // Half the window is the floor. 30 returns already give a wide interval around
  // sigma; anything thinner is a number pretending to be an estimate.
  if (window.length < Math.max(10, Math.floor(lookback / 2))) return null;
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) rets.push(Math.log(window[i] / window[i - 1]));
  if (rets.length < 2) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((acc, x) => acc + (x - m) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 && Number.isFinite(sd) ? sd : null;
}

/** The four exit distances actually in force for one position, as fractions. */
export interface ResolvedBarriers {
  /** Positive magnitude; `null` = no stop at all. */
  stopLoss: number | null;
  /** Positive magnitude; `null` = no upside cap at all. */
  takeProfit: number | null;
  trailArm: number;
  trailDistance: number;
  /** True when the distances came from sigma rather than from fixed percentages. */
  scaled: boolean;
}

/**
 * Turn (config, this position's entry volatility) into concrete distances.
 *
 * The sigma horizon is the TIME STOP, not one day: a barrier the position has
 * `maxHoldDays` to reach must be measured against the move that is actually
 * available over `maxHoldDays`. sigmaH = sigmaDaily * sqrt(trading days in the
 * time stop).
 */
export function resolveBarriers(
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG,
  sigmaDaily: number | null | undefined = null,
): ResolvedBarriers {
  const fixed: ResolvedBarriers = {
    stopLoss: config.stopLoss,
    takeProfit: config.takeProfit,
    trailArm: config.trailArm,
    trailDistance: config.trailDistance,
    scaled: false,
  };
  const sb = config.sigmaBarriers;
  if (!sb || sigmaDaily == null || !(sigmaDaily > 0) || !Number.isFinite(sigmaDaily)) return fixed;
  const horizon = Math.max(1, config.maxHoldDays * PORTFOLIO_TRADING_DAYS_PER_CALENDAR_DAY);
  const sigmaH = sigmaDaily * Math.sqrt(horizon);
  if (!(sigmaH > 0) || !Number.isFinite(sigmaH)) return fixed;
  const at = (mult: number | null): number | null =>
    mult == null || !Number.isFinite(mult) ? null : mult * sigmaH;
  return {
    stopLoss: at(sb.stop),
    takeProfit: at(sb.target),
    trailArm: at(sb.trailArm) ?? fixed.trailArm,
    trailDistance: at(sb.trailDistance) ?? fixed.trailDistance,
    scaled: true,
  };
}

/**
 * Triple barrier + trailing stop, evaluated on adjusted CLOSES only.
 *
 * Intraday highs and lows are deliberately not used: a stop filled at a day's
 * low you could never have traded is fiction. When two barriers break on the
 * same day the most pessimistic one wins (stop before trailing before target),
 * because a single daily bar cannot say which came first.
 *
 * A `null` stop or target is genuinely ABSENT, not "very far away". The shipped
 * book runs with no take-profit at all, and encoding that as 999% would put a
 * meaningless number in the UI and still truncate a ten-bagger.
 */
export function evaluateExit(
  ctx: ExitContext,
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG,
): PortfolioExitReason | null {
  const b = resolveBarriers(config, ctx.sigmaDaily);
  const pnl = ctx.close / ctx.entryPrice - 1;
  if (b.stopLoss != null && pnl <= -b.stopLoss + BARRIER_EPS) return 'stop_loss';
  const peakPnl = ctx.highWaterClose / ctx.entryPrice - 1;
  const trailLevel = ctx.highWaterClose * (1 - b.trailDistance);
  if (peakPnl >= b.trailArm - BARRIER_EPS && ctx.close <= trailLevel * (1 + BARRIER_EPS)) {
    return 'trailing';
  }
  if (b.takeProfit != null && pnl >= b.takeProfit - BARRIER_EPS) return 'take_profit';
  // Calendar days, so a time stop that lands on a weekend closes on the next
  // session — which is what `>=` against the trading calendar produces.
  if (ctx.holdDays >= config.maxHoldDays) return 'time';
  return null;
}

/**
 * Which barrier is nearest, as a fraction of today's price. For the UI.
 *
 * A disabled barrier contributes no candidate. With both price barriers off, the
 * only exit left is the time stop, which has no price distance — the caller gets
 * `null` and the UI shows the hold-day countdown instead of inventing a level.
 */
export function nearestBarrier(
  ctx: ExitContext,
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG,
): { reason: PortfolioExitReason; distance: number } | null {
  if (!(ctx.close > 0) || !(ctx.entryPrice > 0)) return null;
  const b = resolveBarriers(config, ctx.sigmaDaily);
  const cands: { reason: PortfolioExitReason; distance: number }[] = [];
  if (b.stopLoss != null) {
    cands.push({ reason: 'stop_loss', distance: (ctx.entryPrice * (1 - b.stopLoss)) / ctx.close - 1 });
  }
  if (b.takeProfit != null) {
    cands.push({ reason: 'take_profit', distance: (ctx.entryPrice * (1 + b.takeProfit)) / ctx.close - 1 });
  }
  if (ctx.highWaterClose / ctx.entryPrice - 1 >= b.trailArm - BARRIER_EPS) {
    cands.push({
      reason: 'trailing',
      distance: (ctx.highWaterClose * (1 - b.trailDistance)) / ctx.close - 1,
    });
  }
  cands.sort((x, y) => Math.abs(x.distance) - Math.abs(y.distance));
  return cands[0] ?? null;
}

// ── Simulation ──

export interface PortfolioSimInput {
  config: PortfolioConfig;
  /** Ascending, unique. The trading calendar, taken from the SPY series itself. */
  tradingDays: string[];
  /** date → SPY adjusted close. Must cover every trading day. */
  spy: Record<string, number>;
  /** ticker → date → adjusted close. */
  prices: Record<string, Record<string, number>>;
  /** Already filtered to `score >= config.entryScore` by the caller. */
  candidates: PortfolioCandidate[];
}

export interface PortfolioSimResult {
  equity: PortfolioEquityPoint[];
  /** Every position the run opened; still-open ones have `exitDate === null`. */
  positions: PortfolioPosition[];
  events: PortfolioEvent[];
  /** Qualified but never bought — no usable price series. */
  untradable: string[];
}

interface LivePosition {
  id: number;
  ticker: string;
  signalId: number | null;
  entryDate: string;
  entryPrice: number;
  shares: number;
  costBasis: number;
  entryScore: number;
  targetWeight: number;
  highWaterClose: number;
  lastPrice: number;
  spyEntry: number;
  /**
   * Realised daily vol at the entry close, or `null` when the series was too
   * short. Only consulted under `config.sigmaBarriers`; computed once at entry
   * so the barrier never moves after the position is open.
   */
  entrySigmaDaily: number | null;
  /** Consecutive trading days without a fresh close. */
  staleDays: number;
}

interface Book {
  policy: PortfolioCashPolicy;
  cash: number;
  spyShares: number;
  open: LivePosition[];
  closed: PortfolioPosition[];
  cooldown: Map<string, string>;
  nextId: number;
}

function newBook(policy: PortfolioCashPolicy, startingCash: number, spyOpen: number, slipBps: number): Book {
  // Under the `spy` policy the book is fully invested in the index from day one,
  // and pays the same entry slippage the benchmark pays.
  const spyShares = policy === 'spy' ? startingCash / applySlippage(spyOpen, 'buy', slipBps) : 0;
  return {
    policy,
    cash: policy === 'spy' ? 0 : startingCash,
    spyShares,
    open: [],
    closed: [],
    cooldown: new Map(),
    nextId: 1,
  };
}

const positionsValue = (b: Book): number => b.open.reduce((s, p) => s + p.shares * p.lastPrice, 0);
const bookEquity = (b: Book, spyPx: number): number => b.cash + b.spyShares * spyPx + positionsValue(b);

/** Cash reachable today, counting the SPY block that would have to be sold. */
function available(b: Book, spyPx: number, slipBps: number): number {
  return b.cash + b.spyShares * applySlippage(spyPx, 'sell', slipBps);
}

/** Raise `amount` of cash, selling SPY (with slippage) when the policy parks there. */
function raiseCash(b: Book, amount: number, spyPx: number, slipBps: number): void {
  const short = amount - b.cash;
  if (short <= 0) return;
  const net = applySlippage(spyPx, 'sell', slipBps);
  const sell = Math.min(b.spyShares, short / net);
  b.spyShares -= sell;
  b.cash += sell * net;
}

/** Park loose cash back in SPY (with slippage) under the `spy` policy. */
function parkCash(b: Book, spyPx: number, slipBps: number): void {
  if (b.policy !== 'spy' || b.cash <= 0) return;
  b.spyShares += b.cash / applySlippage(spyPx, 'buy', slipBps);
  b.cash = 0;
}

/**
 * First trading day on/after `from` that actually has a close for `ticker`.
 * A date without a price is not a trading day (§ "trading days come from the
 * data"); past `maxSearchDays` the series is treated as absent.
 */
export function firstTradableDay(
  ticker: string,
  from: string,
  tradingDays: readonly string[],
  prices: Record<string, Record<string, number>>,
  maxSearchDays: number = PORTFOLIO_PRICE_SEARCH_DAYS,
): string | null {
  const series = prices[ticker];
  if (!series) return null;
  for (const d of tradingDays) {
    if (d < from) continue;
    if (diffDaysYmd(from, d) > maxSearchDays) return null;
    if (series[d] != null) return d;
  }
  return null;
}

export function simulatePortfolio(input: PortfolioSimInput): PortfolioSimResult {
  const cfg = input.config;
  const slip = cfg.slippageBps;
  // The book does not exist before it opens. Enforced HERE as well as in the
  // caller's price window: the engine is what the tests and the sweep run
  // against, and a rule this load-bearing should not depend on a caller
  // remembering to pre-filter its input.
  const inception = cfg.inceptionDate;
  const days = [...input.tradingDays].sort().filter((d) => !inception || d >= inception);
  const equity: PortfolioEquityPoint[] = [];
  const events: PortfolioEvent[] = [];
  const untradable = new Set<string>();

  if (!days.length) return { equity, positions: [], events, untradable: [] };

  // ── Resolve every candidate to a real, tradable entry day up front. This is
  //    deterministic and keeps the day loop free of price-search logic.
  const byDay = new Map<string, PortfolioCandidate[]>();
  const seen = new Map<string, PortfolioCandidate>();
  const lastDay = days[days.length - 1];
  for (const c of [...input.candidates].sort(
    (a, b) => a.earliestDate.localeCompare(b.earliestDate) || b.score - a.score || a.ticker.localeCompare(b.ticker),
  )) {
    if (c.score < cfg.entryScore) continue;
    // A signal from before inception is DROPPED, not deferred. Resolving it
    // forward would buy a seven-week-old sighting on opening day at a price
    // that already moved — the one thing `earliestEntryDate` exists to prevent.
    if (inception && c.earliestDate < inception) continue;
    const day = firstTradableDay(c.ticker, c.earliestDate, days, input.prices);
    if (!day) {
      // PENDING, not missing. A signal from the most recent session has not had
      // its full search window yet — Friday evening's signal has no Monday close
      // to buy at. Calling that "not tradable" would put a healthy ticker in the
      // data-quality warning and then never take it back out.
      if (addDaysYmd(c.earliestDate, PORTFOLIO_PRICE_SEARCH_DAYS) > lastDay) continue;
      untradable.add(c.ticker);
      events.push({
        date: c.earliestDate,
        kind: 'data_missing',
        ticker: c.ticker,
        score: c.score,
        amount: null,
        note: 'no adjusted close within the search window — not tradable',
      });
      continue;
    }
    // Two sightings can resolve onto the same session; the EARLIER one wins, so
    // the book never quietly upgrades itself to a later, better-informed score.
    const key = `${c.ticker}|${day}`;
    if (seen.has(key)) continue;
    seen.set(key, c);
    const list = byDay.get(day);
    if (list) list.push(c);
    else byDay.set(day, [c]);
  }

  const spyStart = input.spy[days[0]];
  if (!(spyStart > 0)) return { equity, positions: [], events, untradable: [...untradable] };

  const active = newBook(cfg.cashPolicy, cfg.startingCash, spyStart, slip);
  // The comparison book always runs the `idle` policy. When that IS the active
  // policy the two are the same object, so `equityIdle` equals `equity` instead
  // of drifting from a second, pointlessly re-simulated run.
  const idle = cfg.cashPolicy === 'idle' ? active : newBook('idle', cfg.startingCash, spyStart, slip);

  // Benchmark: buy & hold, same day, same capital, same entry slippage.
  const benchShares = cfg.startingCash / applySlippage(spyStart, 'buy', slip);

  for (const d of days) {
    const spyPx = input.spy[d];
    if (!(spyPx > 0)) continue;

    for (const book of idle === active ? [active] : [active, idle]) {
      stepBook(book, d, spyPx, book === active);
    }

    // Round the COMPONENTS first and let the headline be their sum, so
    // `equity = cash + spy_cash_value + positions_value` holds exactly rather
    // than to within three independent roundings. `verify:portfolio` asserts it.
    const cash = round2(active.cash);
    const spyCashValue = round2(active.spyShares * spyPx);
    const posValue = round2(positionsValue(active));
    equity.push({
      date: d,
      cash,
      spyCashValue,
      positionsValue: posValue,
      equity: round2(cash + spyCashValue + posValue),
      equityIdle: round2(bookEquity(idle, spyPx)),
      benchmark: round2(benchShares * spyPx),
      openPositions: active.open.length,
    });
  }

  const positions: PortfolioPosition[] = [
    ...active.closed,
    ...active.open.map((p) => ({
      id: p.id,
      ticker: p.ticker,
      signalId: p.signalId,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      shares: p.shares,
      costBasis: p.costBasis,
      entryScore: p.entryScore,
      targetWeight: p.targetWeight,
      highWaterClose: p.highWaterClose,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
      realizedPnl: null,
      spyEntry: p.spyEntry,
      spyExit: null,
    })),
  ].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.ticker.localeCompare(b.ticker));

  // A ticker that failed once but traded on another day is NOT untradable.
  for (const key of seen.keys()) untradable.delete(key.split("|")[0]);

  return { equity, positions, events, untradable: [...untradable].sort() };

  // ── one day, one book ──
  function stepBook(b: Book, d: string, spyPx: number, record: boolean): void {
    // 1. Mark to market. A missing close is carried forward, not guessed.
    for (const p of b.open) {
      const px = input.prices[p.ticker]?.[d];
      if (px != null && px > 0) {
        p.lastPrice = px;
        p.staleDays = 0;
        if (px > p.highWaterClose) p.highWaterClose = px;
      } else {
        p.staleDays++;
      }
    }

    // 2. Missing quotes are a data incident, not evidence of an executable sale.
    // Keep the holding at its last known mark and report the gap once. Evaluate
    // exit rules only when a real close returns (including overdue time exits).
    for (const p of [...b.open]) {
      let reason: PortfolioExitReason | null = null;
      if (record && p.staleDays === PORTFOLIO_PRICE_SEARCH_DAYS + 1) {
        events.push({
          date: d,
          kind: 'data_missing',
          ticker: p.ticker,
          score: null,
          amount: null,
          note: 'Price data unavailable — position retained at its last known mark; no sale executed',
        });
      }
      if (p.staleDays === 0) {
        reason = evaluateExit(
          {
            entryPrice: p.entryPrice,
            close: p.lastPrice,
            highWaterClose: p.highWaterClose,
            holdDays: diffDaysYmd(p.entryDate, d),
            sigmaDaily: p.entrySigmaDaily,
          },
          cfg,
        );
      }
      if (!reason) continue;
      closePosition(b, p, d, spyPx, reason, record);
    }

    // 3. Entries, strongest signal first.
    const todays = (byDay.get(d) ?? []).slice().sort((x, y) => y.score - x.score || x.ticker.localeCompare(y.ticker));
    for (const c of todays) {
      const px = input.prices[c.ticker]?.[d];
      if (px == null || !(px > 0)) continue; // resolved on this day, so this cannot happen
      if (b.open.some((p) => p.ticker === c.ticker)) continue; // one position per ticker, no averaging up
      const until = b.cooldown.get(c.ticker);
      if (until && d < until) continue;
      if (b.open.length >= cfg.maxPositions) {
        if (record) {
          events.push({
            date: d,
            kind: 'skipped_cap',
            ticker: c.ticker,
            score: c.score,
            amount: null,
            note: `position limit (${cfg.maxPositions}) reached`,
          });
        }
        continue;
      }

      const eq = bookEquity(b, spyPx);
      const { targetWeight, value } = positionSize(c.score, eq, cfg);
      // The target's clamp is not enough: limited cash can fund a smaller fill.
      // Enforce both minimums against equity immediately before this entry.
      const minimumFunding = Math.max(cfg.minTicket, cfg.minWeight * Math.max(0, eq));
      const spend = Math.min(value, available(b, spyPx, slip));
      if (spend < minimumFunding) {
        if (record) {
          events.push({
            date: d,
            kind: 'skipped_no_cash',
            ticker: c.ticker,
            score: c.score,
            amount: round2(spend),
            note: `only ${spend.toFixed(2)} investable, minimum funding is ${minimumFunding.toFixed(2)} (ticket ${cfg.minTicket}, weight ${(cfg.minWeight * 100).toFixed(2)}%)`,
          });
        }
        continue;
      }

      raiseCash(b, spend, spyPx, slip);
      // Spend what was ACTUALLY raised. `spend` and the raised cash agree to
      // ~1e-12, and letting that float through would leave cash at -1e-12 and
      // break the "cash is never negative" invariant on a rounding artefact.
      const outlay = Math.min(spend, b.cash);
      const fill = applySlippage(px, 'buy', slip);
      const shares = outlay / fill; // fractional shares — see the assumptions note
      b.cash -= outlay;
      b.open.push({
        id: b.nextId++,
        ticker: c.ticker,
        signalId: c.signalId,
        entryDate: d,
        entryPrice: fill,
        shares,
        costBasis: outlay,
        entryScore: c.score,
        targetWeight,
        highWaterClose: px,
        lastPrice: px,
        spyEntry: spyPx,
        // Only estimated when a scaled barrier will actually read it — the walk
        // over the whole series is not free, and it is dead weight in the
        // shipped configuration.
        entrySigmaDaily: cfg.sigmaBarriers ? realizedDailyVol(input.prices[c.ticker], d) : null,
        staleDays: 0,
      });
      if (record) {
        events.push({ date: d, kind: 'buy', ticker: c.ticker, score: c.score, amount: round2(outlay), note: null });
      }
    }

    // 4. Whatever is left over goes back into the index under the `spy` policy.
    parkCash(b, spyPx, slip);
  }

  function closePosition(
    b: Book,
    p: LivePosition,
    d: string,
    spyPx: number,
    reason: PortfolioExitReason,
    record: boolean,
  ): void {
    const fill = applySlippage(p.lastPrice, 'sell', slip);
    const proceeds = p.shares * fill;
    b.cash += proceeds;
    b.open = b.open.filter((x) => x !== p);
    b.cooldown.set(p.ticker, addDaysYmd(d, cfg.reentryCooldownDays));
    b.closed.push({
      id: p.id,
      ticker: p.ticker,
      signalId: p.signalId,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      shares: p.shares,
      costBasis: p.costBasis,
      entryScore: p.entryScore,
      targetWeight: p.targetWeight,
      highWaterClose: p.highWaterClose,
      exitDate: d,
      exitPrice: fill,
      exitReason: reason,
      realizedPnl: proceeds - p.costBasis,
      spyEntry: p.spyEntry,
      spyExit: spyPx,
    });
    if (record) {
      events.push({
        date: d,
        kind: reason === 'data_missing' ? 'data_missing' : 'sell',
        ticker: p.ticker,
        score: p.entryScore,
        amount: round2(proceeds - p.costBasis),
        note: reason,
      });
    }
  }
}

/** Money is rounded once, at the boundary, so the stored curve is exact to the cent. */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// ── Derived views ──

export function toClosedPosition(p: PortfolioPosition): PortfolioClosedPosition {
  const returnPct = p.exitPrice != null ? p.exitPrice / p.entryPrice - 1 : 0;
  const spyRet = p.spyEntry != null && p.spyExit != null ? p.spyExit / p.spyEntry - 1 : null;
  return {
    ...p,
    holdDays: p.exitDate ? diffDaysYmd(p.entryDate, p.exitDate) : 0,
    returnPct,
    tradeAlpha: spyRet == null ? null : returnPct - spyRet,
  };
}

export function toOpenPosition(
  p: PortfolioPosition,
  lastPrice: number | null,
  asOf: string,
  equity: number,
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG,
  /**
   * Entry volatility, for the sigma-scaled barriers. Stored positions do not
   * carry one, so callers that cannot supply it pass nothing — harmless while
   * `sigmaBarriers` is null (the shipped default and the only state the runtime
   * rules editor can produce), because `resolveBarriers` then ignores it.
   */
  sigmaDaily: number | null = null,
): PortfolioOpenPosition {
  const px = lastPrice ?? null;
  const marketValue = px != null ? p.shares * px : p.costBasis;
  const near =
    px != null
      ? nearestBarrier(
          {
            entryPrice: p.entryPrice,
            close: px,
            highWaterClose: p.highWaterClose ?? px,
            holdDays: diffDaysYmd(p.entryDate, asOf),
            sigmaDaily,
          },
          config,
        )
      : null;
  return {
    ...p,
    lastPrice: px,
    marketValue,
    unrealizedPct: px != null ? px / p.entryPrice - 1 : null,
    weight: equity > 0 ? marketValue / equity : 0,
    holdDays: diffDaysYmd(p.entryDate, asOf),
    nearestBarrier: near?.reason ?? null,
    nearestBarrierPct: near?.distance ?? null,
  };
}

/**
 * A well-typed "nothing here yet" state. Lives in the pure module because both
 * the main process and the browser build need it, and neither can import the
 * other's copy.
 */
export function emptyPortfolioState(note: string | null = null): PortfolioState {
  return {
    config: DEFAULT_PORTFOLIO_CONFIG,
    meta: {
      available: false,
      firstDate: null,
      lastDate: null,
      backfillStart: null,
      liveStart: null,
      lastRun: null,
      skippedNoCash: 0,
      skippedCap: 0,
      missingPrices: 0,
      suspectPrices: 0,
      untradableTickers: [],
      restatedDays: 0,
      priceAsOf: null,
      readOnly: false,
      note,
    },
    equity: [],
    open: [],
    closed: [],
    events: [],
    stats: computeStats([], [], [], DEFAULT_PORTFOLIO_CONFIG),
  };
}

/** Both series re-based to 0% at the first point — the fairest visual comparison. */
export function rebase(values: readonly number[]): number[] {
  const base = values[0];
  if (!base) return values.map(() => 0);
  return values.map((v) => v / base - 1);
}

// ── Statistics ──

function lastAtOrBefore(points: readonly PortfolioEquityPoint[], date: string): number {
  let idx = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i].date <= date) idx = i;
    else break;
  }
  return idx;
}

function dailyReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (prev > 0) out.push(values[i] / prev - 1);
  }
  return out;
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function maxDrawdown(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return worst;
}

const TRADING_DAYS_PER_YEAR = 252;

function metric(portfolio: number | null, benchmark: number | null, daysRemaining: number | null): PortfolioMetric {
  return {
    portfolio,
    benchmark,
    diff: portfolio != null && benchmark != null ? portfolio - benchmark : null,
    daysRemaining,
  };
}

export function computeStats(
  equity: readonly PortfolioEquityPoint[],
  closed: readonly PortfolioClosedPosition[],
  open: readonly PortfolioOpenPosition[],
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG,
): PortfolioStats {
  const empty: PortfolioStats = {
    spanDays: 0,
    windows: PORTFOLIO_WINDOWS.map((w) => ({
      key: w.key,
      portfolio: null,
      benchmark: null,
      diff: null,
      daysRemaining: w.days,
      n: 0,
    })),
    cagr: metric(null, null, PORTFOLIO_MIN_DAYS_CAGR),
    maxDrawdown: metric(null, null, null),
    volatility: metric(null, null, null),
    sharpe: metric(null, null, PORTFOLIO_MIN_DAYS_SHARPE),
    trades: {
      total: 0,
      closed: 0,
      open: 0,
      winRate: null,
      avgHoldDays: null,
      avgWin: null,
      avgLoss: null,
      best: null,
      worst: null,
      avgTradeAlpha: null,
      alphaN: 0,
      investedRatio: 0,
    },
  };
  if (equity.length < 2) return { ...empty, trades: tradeStats(closed, open, equity) };

  const first = equity[0];
  const last = equity[equity.length - 1];
  const spanDays = diffDaysYmd(first.date, last.date);
  // Day 0 is already NET of one side of entry slippage: the book and the
  // benchmark both buy that morning, so the first curve point is $9,995 of a
  // $10,000 commitment. Measuring "since start" from that point excuses the
  // entry cost and prints a return that contradicts the dollar figure printed
  // beside it — the headline showed −1.26% next to −$130.60, which is −1.31%.
  // What was committed is the basis. Only THIS window starts at the top of the
  // book; 7d/30d anchor on a curve point, where the cost is already inside both
  // ends and cancels.
  const basis = config.startingCash > 0 ? config.startingCash : first.equity;

  const windows: PortfolioWindowStat[] = PORTFOLIO_WINDOWS.map((w) => {
    if (w.days == null) {
      return {
        key: w.key,
        portfolio: last.equity / basis - 1,
        benchmark: last.benchmark / basis - 1,
        diff: last.equity / basis - last.benchmark / basis,
        daysRemaining: null,
        n: equity.length,
      };
    }
    // A window shorter than the history it needs is reported as UNKNOWN. Scaling
    // a 30-day result up to "1 year" would be an invented number, and this whole
    // panel is worthless the moment it prints one.
    if (spanDays < w.days) {
      return { key: w.key, portfolio: null, benchmark: null, diff: null, daysRemaining: w.days - spanDays, n: 0 };
    }
    const idx = lastAtOrBefore(equity, addDaysYmd(last.date, -w.days));
    if (idx < 0) {
      return { key: w.key, portfolio: null, benchmark: null, diff: null, daysRemaining: w.days - spanDays, n: 0 };
    }
    const anchor = equity[idx];
    const p = last.equity / anchor.equity - 1;
    const b = last.benchmark / anchor.benchmark - 1;
    return { key: w.key, portfolio: p, benchmark: b, diff: p - b, daysRemaining: null, n: equity.length - idx - 1 };
  });

  const pv = equity.map((e) => e.equity);
  const bv = equity.map((e) => e.benchmark);
  const pr = dailyReturns(pv);
  const br = dailyReturns(bv);

  const years = spanDays / 365;
  const cagr =
    spanDays >= PORTFOLIO_MIN_DAYS_CAGR && years > 0
      ? metric((last.equity / basis) ** (1 / years) - 1, (last.benchmark / basis) ** (1 / years) - 1, null)
      : metric(null, null, PORTFOLIO_MIN_DAYS_CAGR - spanDays);

  const pVol = stdev(pr) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const bVol = stdev(br) * Math.sqrt(TRADING_DAYS_PER_YEAR);

  const sharpe =
    spanDays >= PORTFOLIO_MIN_DAYS_SHARPE && stdev(pr) > 0 && stdev(br) > 0
      ? metric(
          (mean(pr) / stdev(pr)) * Math.sqrt(TRADING_DAYS_PER_YEAR),
          (mean(br) / stdev(br)) * Math.sqrt(TRADING_DAYS_PER_YEAR),
          null,
        )
      : metric(null, null, Math.max(0, PORTFOLIO_MIN_DAYS_SHARPE - spanDays));

  return {
    spanDays,
    windows,
    cagr,
    maxDrawdown: metric(maxDrawdown(pv), maxDrawdown(bv), null),
    volatility: metric(pVol, bVol, null),
    sharpe,
    trades: tradeStats(closed, open, equity),
  };
}

function tradeStats(
  closed: readonly PortfolioClosedPosition[],
  open: readonly PortfolioOpenPosition[],
  equity: readonly PortfolioEquityPoint[],
): PortfolioTradeStats {
  const last = equity[equity.length - 1];
  const wins = closed.filter((c) => c.returnPct > 0);
  const losses = closed.filter((c) => c.returnPct <= 0);
  const alphas = closed.map((c) => c.tradeAlpha).filter((a): a is number => a != null);
  const sorted = [...closed].sort((a, b) => b.returnPct - a.returnPct);
  return {
    total: closed.length + open.length,
    closed: closed.length,
    open: open.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgHoldDays: closed.length ? mean(closed.map((c) => c.holdDays)) : null,
    avgWin: wins.length ? mean(wins.map((c) => c.returnPct)) : null,
    avgLoss: losses.length ? mean(losses.map((c) => c.returnPct)) : null,
    best: sorted.length ? { ticker: sorted[0].ticker, returnPct: sorted[0].returnPct } : null,
    worst: sorted.length
      ? { ticker: sorted[sorted.length - 1].ticker, returnPct: sorted[sorted.length - 1].returnPct }
      : null,
    avgTradeAlpha: alphas.length ? mean(alphas) : null,
    alphaN: alphas.length,
    investedRatio: last && last.equity > 0 ? last.positionsValue / last.equity : 0,
  };
}
