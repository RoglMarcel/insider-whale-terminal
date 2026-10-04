import { describe, it, expect } from 'vitest';
import {
  addDaysYmd,
  applySlippage,
  computeStats,
  diffDaysYmd,
  earliestEntryDate,
  evaluateExit,
  firstTradableDay,
  nearestBarrier,
  positionSize,
  realizedDailyVol,
  rebase,
  resolveBarriers,
  simulatePortfolio,
  toClosedPosition,
  type PortfolioSimInput,
} from '../src/lib/portfolio-rules';
import { translate, type Lang } from '../src/lib/i18n';
import {
  DEFAULT_PORTFOLIO_CONFIG,
  PORTFOLIO_ENTRY_SCORE,
  PORTFOLIO_INCEPTION,
  PORTFOLIO_SCORE_SPAN,
  CONVICTION_THRESHOLDS,
  PORTFOLIO_TRADING_DAYS_PER_CALENDAR_DAY,
  PORTFOLIO_V1_EXIT_DEFAULTS,
  type PortfolioCandidate,
  type PortfolioConfig,
} from '../src/types';

/**
 * The testing portfolio is a claim about numbers, so the numbers have to be
 * pinned. Everything here runs against the PURE engine — no database, no
 * network — which is the whole reason the rules were split out of the I/O.
 *
 * The two tests that matter most are "no look-ahead" and "determinism": if
 * either of those breaks, every figure the Portfolio tab prints is fiction, and
 * neither failure is visible by looking at a chart.
 */

const cfg = (over: Partial<PortfolioConfig> = {}): PortfolioConfig => ({ ...DEFAULT_PORTFOLIO_CONFIG, ...over });

/**
 * The shipped rules with the book already OPEN. Every fixture below trades a
 * synthetic January 2026 calendar, and the real inception (2026-09-01) would
 * correctly empty all of them; `null` is the engine's "as far back as the data
 * reaches". Inception itself is tested against real dates further down.
 */
const simCfg = (over: Partial<PortfolioConfig> = {}): PortfolioConfig => cfg({ inceptionDate: null, ...over });

/** N consecutive WEEKDAYS from `start` — a stand-in trading calendar. */
function calendar(start: string, n: number): string[] {
  const out: string[] = [];
  let d = start;
  while (out.length < n) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
    d = addDaysYmd(d, 1);
  }
  return out;
}

const flat = (days: readonly string[], px: number): Record<string, number> =>
  Object.fromEntries(days.map((d) => [d, px]));

/** A price path laid onto a calendar; short paths hold their last value. */
function path(days: readonly string[], values: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  days.forEach((d, i) => {
    out[d] = values[Math.min(i, values.length - 1)];
  });
  return out;
}

function input(over: Partial<PortfolioSimInput> = {}): PortfolioSimInput {
  const days = calendar('2026-01-05', 40);
  return {
    config: simCfg(),
    tradingDays: days,
    spy: flat(days, 500),
    prices: {},
    candidates: [],
    ...over,
  };
}

const cand = (over: Partial<PortfolioCandidate> = {}): PortfolioCandidate => ({
  ticker: 'AAA',
  earliestDate: '2026-01-05',
  score: 80,
  signalId: null,
  source: 'signal',
  ...over,
});

// ──────────────────────────────────────────────────────────────────────────

describe('position sizing', () => {
  it('starts at the base weight exactly at the entry score', () => {
    const s = positionSize(PORTFOLIO_ENTRY_SCORE, 10_000);
    expect(s.targetWeight).toBeCloseTo(0.05, 10);
    expect(s.value).toBeCloseTo(500, 10);
  });

  it('scales with the score: 78 → 7.5%', () => {
    expect(positionSize(78, 10_000).targetWeight).toBeCloseTo(0.075, 10);
    expect(positionSize(78, 10_000).value).toBeCloseTo(750, 10);
  });

  it('caps at the maximum weight', () => {
    expect(positionSize(86, 10_000).targetWeight).toBeCloseTo(0.1, 10);
    expect(positionSize(95, 10_000).targetWeight).toBeCloseTo(0.1, 10);
    expect(positionSize(140, 10_000).targetWeight).toBeCloseTo(0.1, 10);
  });

  it('has a ramp the real score range can actually reach', () => {
    // maxWeight binds at entryScore + scoreSpan. At the old threshold of 74
    // that was 90, and the highest score ever written is 85.1 — so the 10% cap
    // was unreachable and every position sized off a fraction of the intended
    // range. The ramp must end just PAST the observed maximum, not far above it.
    const ALL_TIME_HIGH_SCORE = 85.1;
    expect(PORTFOLIO_ENTRY_SCORE + PORTFOLIO_SCORE_SPAN).toBeGreaterThan(ALL_TIME_HIGH_SCORE);
    expect(PORTFOLIO_ENTRY_SCORE + PORTFOLIO_SCORE_SPAN).toBeLessThan(ALL_TIME_HIGH_SCORE + 3);
    // ...which puts the best signal ever seen within a hair of the cap.
    expect(positionSize(ALL_TIME_HIGH_SCORE, 10_000).targetWeight).toBeGreaterThan(0.096);
  });

  it('is zero below the threshold — the score does not qualify at all', () => {
    expect(positionSize(PORTFOLIO_ENTRY_SCORE - 0.1, 10_000)).toEqual({ targetWeight: 0, value: 0 });
    expect(positionSize(0, 10_000)).toEqual({ targetWeight: 0, value: 0 });
  });

  it('floors at the minimum weight when a lowered threshold is used', () => {
    // Threshold 60 anchors the span, so a score of 60 is the BASE weight, not
    // the floor — the floor only binds for scores under the configured entry.
    const c = cfg({ entryScore: 60 });
    expect(positionSize(60, 10_000, c).targetWeight).toBeCloseTo(0.05, 10);
    expect(positionSize(76, 10_000, c).targetWeight).toBeCloseTo(0.1, 10);
  });

  it('sizes off current equity, not the starting cash', () => {
    expect(positionSize(PORTFOLIO_ENTRY_SCORE, 20_000).value).toBeCloseTo(1000, 10);
  });
});

describe('shipped entry threshold', () => {
  it('is 70 — derived from signal supply vs book capacity, not from returns', () => {
    // Changing this is a real decision, not a tuning knob: it sets how much of
    // the 20-slot book gets filled, and therefore how fast closed trades (the
    // only thing that can ever answer the alpha question) accumulate. The
    // derivation is in the comment on PORTFOLIO_ENTRY_SCORE. If you move it,
    // move that comment with it.
    expect(PORTFOLIO_ENTRY_SCORE).toBe(70);
    expect(DEFAULT_PORTFOLIO_CONFIG.entryScore).toBe(70);
  });

  it('still trades at all — CONVICTION_THRESHOLDS.high would not', () => {
    // Only 3 ticker-days in the entire stored history have ever reached 80.
    expect(PORTFOLIO_ENTRY_SCORE).toBeLessThan(CONVICTION_THRESHOLDS.high);
  });
});

describe('slippage', () => {
  it('is charged against the book on both sides', () => {
    expect(applySlippage(100, 'buy', 5)).toBeCloseTo(100.05, 10);
    expect(applySlippage(100, 'sell', 5)).toBeCloseTo(99.95, 10);
  });

  it('reduces the shares bought and the cash received', () => {
    const days = calendar('2026-01-05', 6);
    const res = simulatePortfolio(
      input({
        config: simCfg({ cashPolicy: 'idle' }),
        tradingDays: days,
        spy: flat(days, 500),
        prices: { AAA: flat(days, 100) },
        // Entry score exactly, so the position sits at the BASE weight. This
        // used to hardcode 74 and silently became a 6.25% position — measuring
        // the sizing ramp instead of slippage — the moment the threshold moved.
        candidates: [cand({ earliestDate: days[0], score: PORTFOLIO_ENTRY_SCORE })],
      }),
    );
    const p = res.positions[0];
    expect(p.entryPrice).toBeCloseTo(100.05, 10);
    // 5% of 10,000 buys fewer than 5 shares because the fill is above the close.
    expect(p.shares).toBeLessThan(5);
    expect(p.shares).toBeCloseTo(500 / 100.05, 10);
  });
});

describe('triple barrier', () => {
  const base = { entryPrice: 100, close: 100, highWaterClose: 100, holdDays: 1 };
  /**
   * The v1.4.0 barrier set, pinned EXPLICITLY. These tests are about the
   * mechanism — epsilon handling, priority when several break at once — not
   * about which numbers ship, and riding on the defaults made them silently
   * change meaning when the defaults did. The shipped set is asserted
   * separately in "shipped exit rules" below.
   */
  const v1 = cfg({ ...PORTFOLIO_V1_EXIT_DEFAULTS });
  const ev = (ctx: Partial<typeof base>) => evaluateExit({ ...base, ...ctx }, v1);

  it('takes profit at +20%', () => {
    expect(ev({ close: 119.9, highWaterClose: 119.9 })).toBeNull();
    // 120 / 100 - 1 is 0.19999999999999996 in IEEE-754 — without BARRIER_EPS a
    // position sitting EXACTLY on the target never takes profit.
    expect(ev({ close: 120, highWaterClose: 120 })).toBe('take_profit');
  });

  it('stops out at −10%', () => {
    expect(ev({ close: 90.1 })).toBeNull();
    expect(ev({ close: 90 })).toBe('stop_loss');
  });

  it('times out at 30 calendar days', () => {
    expect(ev({ holdDays: 29 })).toBeNull();
    expect(ev({ holdDays: 30 })).toBe('time');
  });

  it('arms the trailing stop only above +15%', () => {
    // +14% peak, then a 10% give-back — not armed, so no trailing exit.
    expect(ev({ highWaterClose: 114, close: 102.6 })).toBeNull();
    // +15% peak and 10% below it → armed and triggered.
    expect(ev({ highWaterClose: 115, close: 103.5 })).toBe('trailing');
  });

  it('trails from the high-water close, not from the entry', () => {
    expect(ev({ highWaterClose: 150, close: 136 })).toBe('take_profit');
    expect(ev({ highWaterClose: 150, close: 134 })).toBe('trailing');
  });

  it('prefers the pessimistic barrier when several break at once', () => {
    // A day that is both below the stop and (via the high water) below the trail.
    expect(ev({ highWaterClose: 130, close: 89 })).toBe('stop_loss');
    // Trailing and take-profit together → trailing (the lower exit price).
    expect(ev({ highWaterClose: 140, close: 125 })).toBe('trailing');
    // Time and take-profit together → take-profit is the more specific reason.
    expect(ev({ close: 125, highWaterClose: 125, holdDays: 40 })).toBe('take_profit');
  });

  it('honours a reconfigured barrier set', () => {
    const c = cfg({ takeProfit: 0.3, stopLoss: 0.15, maxHoldDays: 10 });
    expect(evaluateExit({ ...base, close: 125, highWaterClose: 125 }, c)).toBeNull();
    expect(evaluateExit({ ...base, close: 130, highWaterClose: 130 }, c)).toBe('take_profit');
    expect(evaluateExit({ ...base, close: 86 }, c)).toBeNull(); // −14% is inside a −15% stop
    expect(evaluateExit({ ...base, close: 85 }, c)).toBe('stop_loss');
    expect(evaluateExit({ ...base, holdDays: 10 }, c)).toBe('time');
  });
});

describe('shipped exit rules (v1.5.0)', () => {
  const base = { entryPrice: 100, close: 100, highWaterClose: 100, holdDays: 1 };

  it('has NO take-profit — the upside is genuinely uncapped, not set to 999%', () => {
    expect(DEFAULT_PORTFOLIO_CONFIG.takeProfit).toBeNull();
    // A ten-bagger keeps running as long as it never gives back the trail.
    expect(evaluateExit({ ...base, close: 1000, highWaterClose: 1000 })).toBeNull();
    expect(evaluateExit({ ...base, close: 1e9, highWaterClose: 1e9 })).toBeNull();
  });

  it('stops out at −25% and times out at 90 calendar days', () => {
    expect(evaluateExit({ ...base, close: 75.1 })).toBeNull();
    expect(evaluateExit({ ...base, close: 75 })).toBe('stop_loss');
    expect(evaluateExit({ ...base, holdDays: 89 })).toBeNull();
    expect(evaluateExit({ ...base, holdDays: 90 })).toBe('time');
  });

  it('trails 20% below the high water once +25%', () => {
    expect(evaluateExit({ ...base, highWaterClose: 124, close: 99.2 })).toBeNull(); // not armed
    expect(evaluateExit({ ...base, highWaterClose: 125, close: 100 })).toBe('trailing');
  });
});

describe('disabled barriers', () => {
  const base = { entryPrice: 100, close: 100, highWaterClose: 100, holdDays: 1 };

  it('never takes profit when takeProfit is null', () => {
    const c = cfg({ takeProfit: null, trailArm: 5, maxHoldDays: 9999 });
    expect(evaluateExit({ ...base, close: 1_000_000, highWaterClose: 1_000_000 }, c)).toBeNull();
  });

  it('never stops out when stopLoss is null', () => {
    const c = cfg({ stopLoss: null, maxHoldDays: 9999 });
    expect(evaluateExit({ ...base, close: 0.01 }, c)).toBeNull();
  });

  it('falls through to the time stop when BOTH price barriers are off', () => {
    const c = cfg({ takeProfit: null, stopLoss: null, trailArm: 1e9, maxHoldDays: 30 });
    expect(evaluateExit({ ...base, close: 5, holdDays: 29 }, c)).toBeNull();
    expect(evaluateExit({ ...base, close: 5, holdDays: 30 }, c)).toBe('time');
  });

  it('still honours the epsilon at the boundary of an ENABLED barrier', () => {
    // Same IEEE-754 trap as +20%: 125 / 100 - 1 is exact, but 90 / 72 - 1 is
    // 0.25000000000000011 and 0.7 * 100 is 70.00000000000001.
    const c = cfg({ takeProfit: 0.25, stopLoss: 0.3 });
    expect(evaluateExit({ ...base, entryPrice: 72, close: 90, highWaterClose: 90 }, c)).toBe('take_profit');
    expect(evaluateExit({ ...base, close: 0.7 * 100 }, c)).toBe('stop_loss');
  });

  it('offers no nearest-barrier candidate for a disabled barrier', () => {
    const ctx = { entryPrice: 100, close: 100, highWaterClose: 100, holdDays: 1 };
    // Default set: no take-profit, so the stop is the only price barrier.
    expect(nearestBarrier(ctx)?.reason).toBe('stop_loss');
    // Both off and the trail unarmed → no price barrier exists at all.
    expect(nearestBarrier(ctx, cfg({ takeProfit: null, stopLoss: null, trailArm: 1e9 }))).toBeNull();
    // Take-profit back on and much closer than the stop → it wins again.
    expect(nearestBarrier(ctx, cfg({ takeProfit: 0.02 }))?.reason).toBe('take_profit');
  });
});

describe('volatility-scaled barriers', () => {
  const base = { entryPrice: 100, close: 100, highWaterClose: 100, holdDays: 1 };

  it('measures realised daily volatility, and refuses to guess on thin history', () => {
    const days = calendar('2026-01-05', 80);
    // A deterministic ±2% zig-zag: sd of log returns is |ln(1.02)| exactly.
    const zig: Record<string, number> = {};
    days.forEach((d, i) => {
      zig[d] = i % 2 === 0 ? 100 : 102;
    });
    const sigma = realizedDailyVol(zig, days[79], 60);
    expect(sigma).not.toBeNull();
    // 61 closes → 60 returns, alternating ±ln(1.02) so the mean is exactly 0;
    // the SAMPLE sd divides by n−1, hence the √(60/59).
    expect(sigma!).toBeCloseTo(Math.log(1.02) * Math.sqrt(60 / 59), 9);
    // Only a handful of closes → null, NOT 0. A zero sigma would collapse every
    // scaled barrier onto the entry price and stop the position out instantly.
    expect(realizedDailyVol(zig, days[4], 60)).toBeNull();
    expect(realizedDailyVol(undefined, days[79], 60)).toBeNull();
  });

  it('scales the barrier by sigma over the TIME-STOP horizon', () => {
    const sigmaDaily = 0.02;
    const c = cfg({ maxHoldDays: 90, sigmaBarriers: { stop: 1, target: 2, trailArm: null, trailDistance: null } });
    const sigmaH = sigmaDaily * Math.sqrt(90 * PORTFOLIO_TRADING_DAYS_PER_CALENDAR_DAY);
    const b = resolveBarriers(c, sigmaDaily);
    expect(b.scaled).toBe(true);
    expect(b.stopLoss!).toBeCloseTo(sigmaH, 12);
    expect(b.takeProfit!).toBeCloseTo(2 * sigmaH, 12);
    // …and the exit rule uses those levels, not the fixed percentages.
    expect(evaluateExit({ ...base, close: 100 * (1 - sigmaH), sigmaDaily }, c)).toBe('stop_loss');
    expect(evaluateExit({ ...base, close: 100 * (1 - sigmaH) + 0.01, sigmaDaily }, c)).toBeNull();
    // Without a sigma in the context the same close is nowhere near the FIXED
    // −25% stop — which is exactly the fallback, and worth pinning.
    expect(evaluateExit({ ...base, close: 100 * (1 - sigmaH) }, c)).toBeNull();
  });

  it('falls back to the fixed percentages when no sigma could be estimated', () => {
    const c = cfg({ stopLoss: 0.25, sigmaBarriers: { stop: 1, target: null, trailArm: null, trailDistance: null } });
    const b = resolveBarriers(c, null);
    expect(b.scaled).toBe(false);
    expect(b.stopLoss).toBe(0.25);
    // A barrier that cannot be computed must not become a barrier that never fires.
    expect(evaluateExit({ ...base, close: 75, sigmaDaily: null }, c)).toBe('stop_loss');
  });
});

describe('how a disabled barrier reads', () => {
  // The rules card composes the exits line from parts. The type system already
  // forces every consumer to handle `takeProfit: null` — `p1(config.takeProfit)`
  // stopped compiling the moment the field became nullable — but it cannot stop
  // the SENTENCE from being wrong. This pins the wording in both languages.
  const line = (c: PortfolioConfig, lang: Lang): string =>
    [
      c.takeProfit == null
        ? translate(lang, 'pf.rules.exitNoTakeProfit')
        : translate(lang, 'pf.rules.exitTakeProfit', { tp: c.takeProfit * 100 }),
      c.stopLoss == null
        ? translate(lang, 'pf.rules.exitNoStopLoss')
        : translate(lang, 'pf.rules.exitStopLoss', { sl: c.stopLoss * 100 }),
      translate(lang, 'pf.rules.exitTrailing', { trailDist: c.trailDistance * 100, trailArm: c.trailArm * 100 }),
      translate(lang, 'pf.rules.exitTime', { hold: c.maxHoldDays }),
    ].join(' · ');

  for (const lang of ['en', 'de'] as const) {
    it(`[${lang}] states that there is no take profit, without printing a level`, () => {
      const shipped = line(DEFAULT_PORTFOLIO_CONFIG, lang);
      const noTp = translate(lang, 'pf.rules.exitNoTakeProfit');
      expect(shipped).toContain(noTp);
      // No digits anywhere in the "there is no barrier" phrases — a disabled
      // barrier that still shows a percentage is the failure this exists to stop.
      expect(noTp).not.toMatch(/\d/);
      expect(translate(lang, 'pf.rules.exitNoStopLoss')).not.toMatch(/\d/);
      // The barriers that ARE in force still print theirs.
      expect(shipped).toContain('25');
      expect(shipped).toContain('90');
    });

    it(`[${lang}] prints the level again once a take profit is switched back on`, () => {
      const withTp = line(cfg({ takeProfit: 0.35 }), lang);
      expect(withTp).not.toContain(translate(lang, 'pf.rules.exitNoTakeProfit'));
      expect(withTp).toContain('35');
    });
  }
});

describe('no look-ahead', () => {
  it('prices a post-close sighting at the NEXT session', () => {
    expect(earliestEntryDate('2026-01-05T13:00:00.000Z')).toBe('2026-01-05');
    expect(earliestEntryDate('2026-01-05T19:59:59.000Z')).toBe('2026-01-05');
    expect(earliestEntryDate('2026-01-05T20:00:00.000Z')).toBe('2026-01-06');
    expect(earliestEntryDate('2026-01-05T23:07:59.662Z')).toBe('2026-01-06');
  });

  it('reads the hour as UTC even without a zone marker (SQLite CURRENT_TIMESTAMP)', () => {
    expect(earliestEntryDate('2026-01-05 23:07:59')).toBe('2026-01-06');
    expect(earliestEntryDate('2026-01-05 09:07:59')).toBe('2026-01-05');
  });

  it('never opens a position before the day the signal was visible', () => {
    const days = calendar('2026-01-05', 10);
    // Deliberately falling prices before the signal: if the engine ever reached
    // back for a cheaper close, the entry price would be below 100.
    const prices = { AAA: path(days, [200, 180, 160, 140, 120, 100, 101, 102, 103, 104]) };
    const res = simulatePortfolio(
      input({
        tradingDays: days,
        spy: flat(days, 500),
        prices,
        candidates: [cand({ earliestDate: earliestEntryDate(`${days[5]}T13:00:00Z`) })],
      }),
    );
    const p = res.positions[0];
    expect(p.entryDate).toBe(days[5]);
    expect(p.entryPrice).toBeGreaterThanOrEqual(100);
    expect(p.entryDate >= days[5]).toBe(true);
  });

  it('slides a post-close signal one session forward in the simulation too', () => {
    const days = calendar('2026-01-05', 10);
    const prices = { AAA: path(days, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) };
    const res = simulatePortfolio(
      input({
        tradingDays: days,
        spy: flat(days, 500),
        prices,
        candidates: [cand({ earliestDate: earliestEntryDate(`${days[2]}T21:00:00Z`) })],
      }),
    );
    // Seen after the close on day 2 → filled on day 3's close (40), not day 2's (30).
    expect(res.positions[0].entryDate).toBe(days[3]);
    expect(res.positions[0].entryPrice).toBeCloseTo(applySlippage(40, 'buy', 5), 10);
  });
});

describe('determinism', () => {
  const build = (): PortfolioSimInput => {
    const days = calendar('2026-01-05', 40);
    return input({
      tradingDays: days,
      spy: path(days, days.map((_, i) => 500 + i * 0.7)),
      prices: {
        AAA: path(days, days.map((_, i) => 100 + Math.sin(i) * 8)),
        BBB: path(days, days.map((_, i) => 50 + i * 1.4)),
        CCC: path(days, days.map((_, i) => 20 - i * 0.35)),
      },
      candidates: [
        cand({ ticker: 'AAA', earliestDate: days[1], score: 76 }),
        cand({ ticker: 'BBB', earliestDate: days[2], score: 84 }),
        cand({ ticker: 'CCC', earliestDate: days[3], score: 91 }),
        cand({ ticker: 'AAA', earliestDate: days[20], score: 78 }),
      ],
    });
  };

  it('produces an identical curve, trade list and event log on a second run', () => {
    const a = simulatePortfolio(build());
    const b = simulatePortfolio(build());
    expect(b.equity).toEqual(a.equity);
    expect(b.positions).toEqual(a.positions);
    expect(b.events).toEqual(a.events);
  });

  it('is unaffected by the order candidates arrive in', () => {
    const base = build();
    const shuffled = { ...base, candidates: [...base.candidates].reverse() };
    expect(simulatePortfolio(shuffled).equity).toEqual(simulatePortfolio(base).equity);
  });
});

describe('book invariants', () => {
  it('keeps equity = cash + parked SPY + positions on every single day', () => {
    const days = calendar('2026-01-05', 30);
    const res = simulatePortfolio(
      input({
        tradingDays: days,
        spy: path(days, days.map((_, i) => 500 + i)),
        prices: { AAA: path(days, days.map((_, i) => 100 + i * 2)), BBB: path(days, days.map((_, i) => 40 - i * 0.5)) },
        candidates: [cand({ ticker: 'AAA', earliestDate: days[1] }), cand({ ticker: 'BBB', earliestDate: days[2] })],
      }),
    );
    expect(res.equity.length).toBe(days.length);
    for (const p of res.equity) {
      expect(Math.abs(p.equity - (p.cash + p.spyCashValue + p.positionsValue))).toBeLessThanOrEqual(0.01);
    }
  });

  it('never lets cash go negative, even when every signal fires at once', () => {
    const days = calendar('2026-01-05', 12);
    const tickers = Array.from({ length: 30 }, (_, i) => `T${String(i).padStart(2, '0')}`);
    const prices = Object.fromEntries(tickers.map((t) => [t, flat(days, 100)]));
    const res = simulatePortfolio(
      input({
        config: simCfg({ cashPolicy: 'idle' }),
        tradingDays: days,
        spy: flat(days, 500),
        prices,
        candidates: tickers.map((t) => cand({ ticker: t, earliestDate: days[0], score: 90 })),
      }),
    );
    for (const p of res.equity) expect(p.cash).toBeGreaterThanOrEqual(0);
    expect(res.events.some((e) => e.kind === 'skipped_no_cash')).toBe(true);
  });

  it('holds at most maxPositions and never two lots of one ticker', () => {
    const days = calendar('2026-01-05', 12);
    const tickers = Array.from({ length: 26 }, (_, i) => `T${String(i).padStart(2, '0')}`);
    const prices = Object.fromEntries(tickers.map((t) => [t, flat(days, 100)]));
    const res = simulatePortfolio(
      input({
        // Tiny, fixed weights so the CAP binds before the CASH does.
        config: simCfg({ cashPolicy: 'idle', baseWeight: 0.03, maxWeight: 0.03, minWeight: 0.03 }),
        tradingDays: days,
        spy: flat(days, 500),
        prices,
        candidates: [
          ...tickers.map((t) => cand({ ticker: t, earliestDate: days[0], score: 80 })),
          // A second signal on an already-open ticker must NOT average up.
          cand({ ticker: 'T00', earliestDate: days[3], score: 90 }),
        ],
      }),
    );
    for (const p of res.equity) expect(p.openPositions).toBeLessThanOrEqual(DEFAULT_PORTFOLIO_CONFIG.maxPositions);
    expect(res.events.filter((e) => e.kind === 'skipped_cap').length).toBe(6);
    expect(res.positions.filter((p) => p.ticker === 'T00').length).toBe(1);
  });

  it('locks a ticker out for the cooldown after a sale', () => {
    const days = calendar('2026-01-05', 30);
    // Straight to a take-profit on day 2, then a fresh signal three days later.
    // The take-profit is set EXPLICITLY: the shipped book has none, and this
    // test is about the cooldown, not about which barrier caused the sale.
    const res = simulatePortfolio(
      input({
        config: simCfg({ takeProfit: 0.2 }),
        tradingDays: days,
        spy: flat(days, 500),
        prices: { AAA: path(days, [100, 100, 130, 130, 130, 130, 130, 130, 130, 130, 130]) },
        candidates: [
          cand({ ticker: 'AAA', earliestDate: days[0] }),
          cand({ ticker: 'AAA', earliestDate: days[4] }), // inside the 10-day cooldown
          cand({ ticker: 'AAA', earliestDate: days[15] }), // outside it
        ],
      }),
    );
    const entries = res.positions.map((p) => p.entryDate);
    expect(entries).toContain(days[0]);
    expect(entries).not.toContain(days[4]);
    expect(entries.length).toBe(2);
  });

  it('reproduces the benchmark as a plain SPY buy & hold', () => {
    const days = calendar('2026-01-05', 20);
    const spy = path(days, days.map((_, i) => 500 * 1.001 ** i));
    const res = simulatePortfolio(input({ tradingDays: days, spy }));
    const shares = 10_000 / applySlippage(spy[days[0]], 'buy', 5);
    for (const p of res.equity) {
      expect(p.benchmark).toBeCloseTo(Math.round(shares * spy[p.date] * 100) / 100, 2);
    }
  });

  it("tracks the index exactly while no signal fires (the 'spy' cash policy)", () => {
    const days = calendar('2026-01-05', 15);
    const spy = path(days, days.map((_, i) => 500 + i * 3));
    const res = simulatePortfolio(input({ tradingDays: days, spy }));
    for (const p of res.equity) expect(p.equity).toBeCloseTo(p.benchmark, 2);
  });

  it("leaves idle cash flat under the 'idle' policy", () => {
    const days = calendar('2026-01-05', 15);
    const res = simulatePortfolio(
      input({ config: simCfg({ cashPolicy: 'idle' }), tradingDays: days, spy: path(days, days.map((_, i) => 500 + i * 3)) }),
    );
    for (const p of res.equity) expect(p.equity).toBeCloseTo(10_000, 6);
  });
});

describe('price gaps', () => {
  const days = calendar('2026-01-05', 15);

  it('slides an entry over a weekend to the next session with a price', () => {
    // 2026-01-10 is a Saturday; the signal lands there and must fill on Monday.
    const res = simulatePortfolio(
      input({
        tradingDays: days,
        spy: flat(days, 500),
        prices: { AAA: flat(days, 100) },
        candidates: [cand({ earliestDate: '2026-01-10' })],
      }),
    );
    expect(res.positions[0].entryDate).toBe('2026-01-12');
  });

  it('slides over a mid-week hole in the series', () => {
    const px = flat(days, 100);
    delete px[days[3]];
    delete px[days[4]];
    const res = simulatePortfolio(
      input({ tradingDays: days, spy: flat(days, 500), prices: { AAA: px }, candidates: [cand({ earliestDate: days[3] })] }),
    );
    expect(res.positions[0].entryDate).toBe(days[5]);
  });

  it('reports data_missing when the gap exceeds the search window', () => {
    const px: Record<string, number> = { [days[0]]: 100, [days[12]]: 100 };
    const res = simulatePortfolio(
      input({ tradingDays: days, spy: flat(days, 500), prices: { AAA: px }, candidates: [cand({ earliestDate: days[2] })] }),
    );
    expect(res.positions.length).toBe(0);
    expect(res.untradable).toEqual(['AAA']);
    expect(res.events.filter((e) => e.kind === 'data_missing').length).toBe(1);
  });

  it('treats a signal from the most recent session as pending, not missing', () => {
    // Seen on the last day in the calendar: its search window has not elapsed,
    // so there is nothing to conclude yet.
    const res = simulatePortfolio(
      input({
        tradingDays: days,
        spy: flat(days, 500),
        prices: { AAA: flat(days.slice(0, days.length - 1), 100) },
        candidates: [cand({ earliestDate: days[days.length - 1] })],
      }),
    );
    expect(res.untradable).toEqual([]);
    expect(res.events.filter((e) => e.kind === 'data_missing')).toEqual([]);
  });

  it('has no series at all → not tradable, and the ticker is named', () => {
    const res = simulatePortfolio(
      input({ tradingDays: days, spy: flat(days, 500), prices: {}, candidates: [cand({ ticker: 'GONE' })] }),
    );
    expect(res.untradable).toEqual(['GONE']);
    expect(res.positions.length).toBe(0);
  });

  it('keeps a position open when quotes stop and reports the stale mark', () => {
    const long = calendar('2026-01-05', 25);
    const px: Record<string, number> = {};
    for (const d of long.slice(0, 6)) px[d] = 100;
    const res = simulatePortfolio(
      input({ tradingDays: long, spy: flat(long, 500), prices: { AAA: px }, candidates: [cand({ earliestDate: long[0] })] }),
    );
    expect(res.positions[0].exitReason).toBeNull();
    expect(res.positions[0].exitDate).toBeNull();
    expect(res.positions[0].realizedPnl).toBeNull();
    expect(res.events.filter((e) => e.kind === 'sell')).toHaveLength(0);
    expect(res.events.filter((e) => e.kind === 'data_missing')).toHaveLength(1);
    expect(res.equity.at(-1)?.openPositions).toBe(1);
  });

  it('executes a real stop only when a quote returns after a long gap', () => {
    const long = calendar('2026-01-05', 25);
    const px = { ...flat(long.slice(0, 6), 100), [long[20]]: 60 };
    const res = simulatePortfolio(input({
      tradingDays: long, spy: flat(long, 500), prices: { AAA: px },
      candidates: [cand({ earliestDate: long[0] })],
    }));
    expect(res.positions[0].exitReason).toBe('stop_loss');
    expect(res.positions[0].exitDate).toBe(long[20]);
    expect(res.positions[0].exitPrice).toBeCloseTo(applySlippage(60, 'sell', 5), 10);
  });

  it('does not mark a ticker untradable when another sighting of it did trade', () => {
    const long = calendar('2026-01-05', 30);
    const px = flat(long, 100);
    delete px[long[20]];
    delete px[long[21]];
    delete px[long[22]];
    delete px[long[23]];
    delete px[long[24]];
    delete px[long[25]];
    delete px[long[26]];
    const res = simulatePortfolio(
      input({
        tradingDays: long,
        spy: flat(long, 500),
        prices: { AAA: px },
        candidates: [cand({ earliestDate: long[0] }), cand({ earliestDate: long[20] })],
      }),
    );
    expect(res.untradable).toEqual([]);
  });
});

describe('split safety', () => {
  const days = calendar('2026-01-05', 15);
  // A 2:1 split on day 5. RAW closes halve; ADJUSTED closes do not move at all.
  const raw = path(days, [100, 100, 100, 100, 100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
  const adjusted = flat(days, 50);

  it('would stop out on raw closes', () => {
    const res = simulatePortfolio(
      input({ tradingDays: days, spy: flat(days, 500), prices: { AAA: raw }, candidates: [cand({ earliestDate: days[0] })] }),
    );
    expect(res.positions[0].exitReason).toBe('stop_loss');
  });

  it('does not stop out on adjusted closes', () => {
    const res = simulatePortfolio(
      input({
        tradingDays: days,
        spy: flat(days, 500),
        prices: { AAA: adjusted },
        candidates: [cand({ earliestDate: days[0] })],
      }),
    );
    expect(res.positions[0].exitReason).toBeNull();
  });
});

describe('trade alpha', () => {
  it('measures the benchmark over EXACTLY the same holding period', () => {
    const days = calendar('2026-01-05', 12);
    const res = simulatePortfolio(
      input({
        config: simCfg({ takeProfit: 0.2 }), // explicit: the shipped book has none
        tradingDays: days,
        spy: path(days, [500, 505, 510, 515, 520, 525, 530, 535, 540, 545, 550, 555]),
        prices: { AAA: path(days, [100, 100, 100, 100, 125, 125, 125, 125, 125, 125, 125, 125]) },
        candidates: [cand({ earliestDate: days[0] })],
      }),
    );
    const closed = toClosedPosition(res.positions[0]);
    expect(closed.exitReason).toBe('take_profit');
    expect(closed.spyEntry).toBe(500);
    expect(closed.spyExit).toBe(520);
    // Position ≈ +24.9% after two-sided slippage, SPY +4% over the same 4 days.
    expect(closed.tradeAlpha).toBeCloseTo(closed.returnPct - 0.04, 10);
    expect(closed.holdDays).toBe(diffDaysYmd(days[0], days[4]));
  });
});

describe('inception', () => {
  // The book opens mid-calendar so both sides of the boundary are real days.
  const days = calendar('2026-01-05', 20);
  const open = days[8];
  const base = {
    tradingDays: days,
    spy: flat(days, 500),
    prices: { OLD: flat(days, 100), NEW: flat(days, 100) },
  };

  it('does not exist before opening day', () => {
    const res = simulatePortfolio(input({ ...base, config: cfg({ inceptionDate: open }) }));
    expect(res.equity.length).toBeGreaterThan(0);
    expect(res.equity[0].date).toBe(open);
    expect(res.equity.every((p) => p.date >= open)).toBe(true);
  });

  it('DROPS a signal from before it rather than buying it late', () => {
    // The whole point of the reset. Resolving a stale signal forward would buy
    // a sighting the market has already digested, at a price that moved without
    // the book — and it would do it on opening day, where it looks like alpha.
    const res = simulatePortfolio(
      input({
        ...base,
        config: cfg({ inceptionDate: open }),
        candidates: [
          cand({ ticker: 'OLD', earliestDate: days[1], score: 90 }),
          cand({ ticker: 'NEW', earliestDate: days[10], score: 90 }),
        ],
      }),
    );
    const bought = res.positions.map((p) => p.ticker);
    expect(bought).toContain('NEW');
    expect(bought).not.toContain('OLD');
    // Dropped is not the same as UNTRADABLE: OLD has a perfectly good price
    // series and must not turn up in the data-quality warning.
    expect(res.untradable).not.toContain('OLD');
    expect(res.events.some((e) => e.ticker === 'OLD')).toBe(false);
  });

  it('reaches as far back as the data does when it is null', () => {
    const res = simulatePortfolio(
      input({
        ...base,
        config: cfg({ inceptionDate: null }),
        candidates: [cand({ ticker: 'OLD', earliestDate: days[1], score: 90 })],
      }),
    );
    expect(res.equity[0].date).toBe(days[0]);
    expect(res.positions.map((p) => p.ticker)).toContain('OLD');
  });

  it('ships with a real opening day, so the shipped book is live-only', () => {
    // A default of null would silently restore the backfill on the next rebuild.
    expect(DEFAULT_PORTFOLIO_CONFIG.inceptionDate).toBe(PORTFOLIO_INCEPTION);
    expect(PORTFOLIO_INCEPTION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('statistics', () => {
  const days = calendar('2026-01-05', 40);
  const res = simulatePortfolio(
    input({ tradingDays: days, spy: path(days, days.map((_, i) => 500 * 1.002 ** i)) }),
  );
  const stats = computeStats(res.equity, [], []);

  it('reports n/a plus the days still missing for windows longer than the history', () => {
    const w6m = stats.windows.find((w) => w.key === '6m');
    const w1y = stats.windows.find((w) => w.key === '1y');
    expect(w6m?.portfolio).toBeNull();
    expect(w6m?.benchmark).toBeNull();
    expect(w6m?.daysRemaining).toBeGreaterThan(0);
    expect(w1y?.daysRemaining).toBeGreaterThan(w6m!.daysRemaining!);
  });

  it('computes the windows it does have history for', () => {
    const w7 = stats.windows.find((w) => w.key === '7d');
    const max = stats.windows.find((w) => w.key === 'max');
    expect(w7?.portfolio).not.toBeNull();
    expect(max?.portfolio).not.toBeNull();
    expect(max?.daysRemaining).toBeNull();
  });

  it('withholds CAGR under 90 days and Sharpe under 60', () => {
    expect(stats.cagr.portfolio).toBeNull();
    expect(stats.cagr.daysRemaining).toBeGreaterThan(0);
    expect(stats.sharpe.portfolio).toBeNull();
  });

  it('returns nothing rather than zeros for an empty curve', () => {
    const s = computeStats([], [], []);
    expect(s.spanDays).toBe(0);
    expect(s.windows.every((w) => w.portfolio === null)).toBe(true);
    expect(s.trades.winRate).toBeNull();
    expect(s.trades.avgTradeAlpha).toBeNull();
  });

  it('measures "since start" against the capital COMMITTED, not day 0\'s value', () => {
    // Day 0 is already net of one side of entry slippage — the book and the
    // benchmark both buy that morning — so the first curve point is $9,995 of a
    // $10,000 commitment. Basing the return on it made the headline print
    // −1.26% next to −$130.60, two numbers that cannot both describe the same
    // book. The percentage has to reconcile with the dollars beside it.
    const c = cfg();
    const max = stats.windows.find((w) => w.key === 'max')!;
    const last = res.equity[res.equity.length - 1];
    expect(res.equity[0].equity).toBeCloseTo(c.startingCash / (1 + c.slippageBps / 10_000), 2);
    expect(max.portfolio).toBeCloseTo(last.equity / c.startingCash - 1, 10);
    expect(max.benchmark).toBeCloseTo(last.benchmark / c.startingCash - 1, 10);
    // The entry cost is inside the number, so it is strictly worse than the
    // reading that started at day 0.
    expect(max.portfolio!).toBeLessThan(last.equity / res.equity[0].equity - 1);
  });

  it('leaves the shorter windows anchored on the curve', () => {
    // 7d/30d start mid-book, where the entry cost sits inside BOTH ends and
    // cancels. Only the window that starts at the top of the book needs the
    // committed capital.
    const w7 = stats.windows.find((w) => w.key === '7d')!;
    const last = res.equity[res.equity.length - 1];
    const anchor = res.equity[res.equity.length - 1 - w7.n];
    expect(w7.portfolio).toBeCloseTo(last.equity / anchor.equity - 1, 10);
  });

  it('measures drawdown peak-to-trough', () => {
    const curve = [1000, 1200, 900, 1100].map((v, i) => ({
      date: addDaysYmd('2026-01-05', i),
      cash: 0,
      spyCashValue: 0,
      positionsValue: v,
      equity: v,
      equityIdle: v,
      benchmark: 1000,
      openPositions: 0,
    }));
    const s = computeStats(curve, [], []);
    expect(s.maxDrawdown.portfolio).toBeCloseTo(-0.25, 10);
    expect(s.maxDrawdown.benchmark).toBeCloseTo(0, 10);
  });
});

describe('helpers', () => {
  it('rebases a series to 0% at its first point', () => {
    const r = rebase([100, 110, 90]);
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo(0.1, 10);
    expect(r[2]).toBeCloseTo(-0.1, 10);
    expect(rebase([0, 5])).toEqual([0, 0]);
  });

  it('does UTC calendar maths, not local', () => {
    expect(addDaysYmd('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDaysYmd('2026-01-05', '2026-02-04')).toBe(30);
  });

  it('finds the first tradable day within the search window', () => {
    const days = calendar('2026-01-05', 10);
    const prices = { AAA: { [days[6]]: 10, [days[7]]: 11 } };
    expect(firstTradableDay('AAA', days[5], days, prices)).toBe(days[6]);
    // days[0] is 8 calendar days before the first close — past the search window.
    expect(firstTradableDay('AAA', days[0], days, prices)).toBeNull();
    expect(firstTradableDay('ZZZ', days[0], days, prices)).toBeNull();
  });
});


describe('minimum funded position size', () => {
  const run = (over: Partial<PortfolioConfig> = {}) => {
    const days = calendar('2026-01-05', 2);
    const tickers = ['AAA', 'BBB', 'CCC', 'DDD'];
    return simulatePortfolio(input({
      config: simCfg({ cashPolicy: 'idle', slippageBps: 0, baseWeight: 0.3,
        maxWeight: 0.3, minWeight: 0.25, minTicket: 100, ...over }),
      tradingDays: days, spy: flat(days, 500),
      prices: Object.fromEntries(tickers.map((t) => [t, flat(days, 100)])),
      candidates: tickers.map((ticker) => cand({ ticker, earliestDate: days[0], score: 80 })),
    }));
  };

  it.each(['idle', 'spy'] as const)('rejects above-ticket funding below minWeight with %s cash', (cashPolicy) => {
    const result = run({ cashPolicy, slippageBps: 5 });
    expect(result.positions.map((p) => p.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
    const skipped = result.events.find((e) => e.ticker === 'DDD' && e.kind === 'skipped_no_cash');
    expect(skipped).toBeDefined();
    expect(skipped!.amount).toBeGreaterThan(100);
    expect(skipped!.amount).toBeLessThan(2500);
    expect(result.equity.every((e) => e.cash >= 0)).toBe(true);
  });

  it('accepts a partial fill exactly at the weight floor', () => {
    const result = run({ minWeight: 0.1 });
    const last = result.positions.find((p) => p.ticker === 'DDD');
    expect(last?.costBasis).toBe(1000);
    expect(last?.targetWeight).toBe(0.3);
    expect(result.events.filter((e) => e.kind === 'skipped_no_cash')).toHaveLength(0);
  });

  it('rejects a partial fill just below the weight floor', () => {
    expect(run({ minWeight: 0.100001 }).positions).toHaveLength(3);
  });

  it('enforces the minimum ticket when it is the stricter floor', () => {
    expect(run({ minWeight: 0.05, minTicket: 1100 }).positions).toHaveLength(3);
  });

  it('keeps the current shipped weights and position limit', () => {
    expect(DEFAULT_PORTFOLIO_CONFIG).toMatchObject({ baseWeight: 0.05, minWeight: 0.03, maxWeight: 0.1, maxPositions: 20 });
  });
});
