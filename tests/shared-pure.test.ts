import { describe, it, expect } from 'vitest';
import {
  daysBetween,
  businessDaysBetween,
  isLateFiling,
  normalizeInsiderName,
  classifyInsiderPattern,
  computeSourceHealth,
  sourceStatus,
  evaluateAlertRules,
  filterSignals,
  isComboSignal,
  isBigPlayer,
  isBigPlayerByCap,
  isSourceUnlocked,
  dropRate,
  sourceLabel,
  DEFAULT_FILTER,
  type Signal,
  type AlertRule,
  type ScoreBreakdown,
  type SourceHealthIssue,
} from '../src/types';
import { ymd } from './helpers';

describe('daysBetween', () => {
  it('a date-only string retains its UTC calendar day', () => {
    // Constructed the same way, the difference must be an exact whole number of
    // days regardless of the machine's timezone.
    const to = Date.UTC(2026, 5, 15);
    expect(daysBetween('2026-06-01', to)).toBe(14);
  });
  it('survives a DST transition (US clocks move on 2026-03-08)', () => {
    const to = Date.UTC(2026, 2, 15);
    expect(daysBetween('2026-03-01', to)).toBe(14);
  });
  it('handles full ISO timestamps', () => {
    const t = Date.parse('2026-08-20T00:00:00Z');
    expect(daysBetween('2026-08-20T00:00:00Z', t + 86_400_000)).toBe(1);
  });
  it('unparseable / empty / null → null (never 0, never NaN)', () => {
    expect(daysBetween('not-a-date')).toBeNull();
    expect(daysBetween('')).toBeNull();
    expect(daysBetween(null)).toBeNull();
    expect(daysBetween(undefined)).toBeNull();
  });
  it('a future date yields a negative age', () => {
    const to = new Date(2026, 0, 1).getTime();
    expect(daysBetween('2026-01-11', to)).toBe(-10);
  });
});

describe('businessDaysBetween / isLateFiling', () => {
  it('excludes weekends', () => {
    // 2026-06-01 is a Monday; 2026-06-08 is the next Monday.
    expect(businessDaysBetween('2026-06-01', '2026-06-08')).toBe(5);
  });
  it('same day is zero and reversed order is zero (never negative)', () => {
    expect(businessDaysBetween('2026-06-01', '2026-06-01')).toBe(0);
    expect(businessDaysBetween('2026-06-08', '2026-06-01')).toBe(0);
  });
  it('missing input → null', () => {
    expect(businessDaysBetween(null, '2026-06-01')).toBeNull();
    expect(businessDaysBetween('2026-06-01', null)).toBeNull();
    expect(businessDaysBetween('nope', '2026-06-01')).toBeNull();
  });
  it('flags a filing later than 4 business days, from both sides', () => {
    expect(isLateFiling('2026-06-01', '2026-06-05')).toBe(false); // 4 business days
    expect(isLateFiling('2026-06-01', '2026-06-08')).toBe(true); // 5
    expect(isLateFiling('2026-06-10', '2026-06-12')).toBe(false);
    expect(isLateFiling(null, '2026-06-12')).toBe(false);
  });
});

describe('normalizeInsiderName', () => {
  it('is word-order insensitive', () => {
    expect(normalizeInsiderName('Doe John')).toBe(normalizeInsiderName('John Doe'));
  });
  it('strips a trailing role suffix', () => {
    expect(normalizeInsiderName('Jane Doe CEO')).toBe(normalizeInsiderName('Jane Doe Director'));
  });
  it('strips a full title glued onto the surname', () => {
    expect(normalizeInsiderName('Genner Gareth NevilleChief Executive Officer')).toBe(
      normalizeInsiderName('Gareth Neville Genner'),
    );
  });
  it('does not strip a suffix that would leave less than 3 characters', () => {
    expect(normalizeInsiderName('Li CEO')).not.toBe('');
  });
  it('drops punctuation and case', () => {
    expect(normalizeInsiderName("O'Sullivan, Michael J.")).toBe(normalizeInsiderName('michael j osullivan'));
  });
  it('empty input → empty key (so the caller can skip it)', () => {
    expect(normalizeInsiderName('')).toBe('');
    expect(normalizeInsiderName(undefined as unknown as string)).toBe('');
  });
});

describe('classifyInsiderPattern', () => {
  it('a first-ever buy is opportunistic', () => {
    expect(classifyInsiderPattern(['2026-06-01'])).toBe('opportunistic');
  });
  it('the same calendar month across years is routine', () => {
    expect(classifyInsiderPattern(['2023-03-10', '2024-03-05', '2025-03-12'])).toBe('routine');
  });
  it('a within-one-year cluster is NOT routine', () => {
    expect(classifyInsiderPattern(['2025-03-01', '2025-03-15', '2025-03-20'])).toBeNull();
  });
  it('mixed months make no claim', () => {
    expect(classifyInsiderPattern(['2023-03-10', '2024-07-05', '2025-11-12'])).toBeNull();
  });
  it('too few observations make no claim', () => {
    expect(classifyInsiderPattern(['2024-01-01', '2025-06-01'])).toBeNull();
  });
  it('empty and unparseable input make no claim', () => {
    expect(classifyInsiderPattern([])).toBeNull();
    expect(classifyInsiderPattern(['nope', ''])).toBeNull();
  });
  it('needs ≥60% in one month', () => {
    // 3 of 6 in March = 50% → not routine.
    expect(
      classifyInsiderPattern(['2023-03-01', '2024-03-01', '2025-03-01', '2023-07-01', '2024-08-01', '2025-09-01']),
    ).toBeNull();
  });
});

describe('computeSourceHealth', () => {
  const healthy = { openinsider: 50, finviz: 20 };
  const zero = { openinsider: 0, finviz: 22 };
  const hardFail = { openinsider: -1, finviz: 22 };

  it('flags a healthy source that goes to zero for 2+ consecutive runs', () => {
    const issues = computeSourceHealth(['openinsider', 'finviz'], [zero, zero, healthy, healthy, healthy]);
    expect(issues.map((i) => i.source)).toEqual(['openinsider']);
    expect(issues[0].kind).toBe('dead');
  });
  it('does not flag a single zero run', () => {
    expect(computeSourceHealth(['openinsider'], [zero, healthy, healthy, healthy])).toHaveLength(0);
  });
  it('never flags a chronically empty source', () => {
    expect(computeSourceHealth(['x'], [{ x: 0 }, { x: 0 }, { x: 0 }, { x: 0 }, { x: 0 }])).toHaveLength(0);
  });
  it('flags two consecutive HARD failures immediately, without a long history', () => {
    const issues = computeSourceHealth(['openinsider'], [hardFail, hardFail]);
    expect(issues.map((i) => i.kind)).toEqual(['dead']);
  });
  it('flags an intermittent (flapping) source once it has enough history', () => {
    const runs = [healthy, zero, healthy, zero, healthy, healthy];
    const issues = computeSourceHealth(['openinsider'], runs);
    expect(issues.map((i) => i.kind)).toEqual(['flapping']);
  });
  it('ignores runs the source did not participate in', () => {
    const issues = computeSourceHealth(['openinsider'], [zero, zero, {}, {}, healthy, healthy, healthy]);
    expect(issues[0].consecutiveZeroRuns).toBe(2);
    expect(issues[0].runsInWindow).toBe(5);
  });
  it('needs at least two participating runs', () => {
    expect(computeSourceHealth(['openinsider'], [healthy])).toHaveLength(0);
  });
});

describe('sourceStatus', () => {
  const issue = (kind: 'dead' | 'flapping'): SourceHealthIssue => ({
    source: 'openinsider',
    kind,
    consecutiveZeroRuns: kind === 'dead' ? 2 : 0,
    rollingMedian: 370,
    zeroRunsInWindow: 2,
    runsInWindow: 12,
  });

  it('reports a flapping source as flapping even when the NEWEST run is the failure', () => {
    // The regression this file exists to prevent. OpenInsider's real history on
    // 2026-08-31: 12 runs, 10 of them 338–415 rows, hard-failing on the newest.
    // The old mapping called that "dead" and fired the red broken-source banner.
    const counts = [-1, 369, 367, 366, 344, 338, 377, 376, -1, 369, 364, 415];
    expect(sourceStatus(issue('flapping'), counts)).toBe('flapping');
  });
  it('still reports a genuinely dead source as dead', () => {
    expect(sourceStatus(issue('dead'), [0, 0, 370, 366, 380])).toBe('dead');
  });
  it('treats a single hard failure with no issue as degraded, not dead', () => {
    expect(sourceStatus(undefined, [-1, 370, 366, 380])).toBe('degraded');
  });
  it('treats a single zero run below a healthy median as degraded', () => {
    expect(sourceStatus(undefined, [0, 370, 366, 380])).toBe('degraded');
  });
  it('reports a source producing rows as healthy', () => {
    expect(sourceStatus(undefined, [370, 366, 380])).toBe('healthy');
  });
  it('reports a source with no participating runs as unknown', () => {
    expect(sourceStatus(undefined, [])).toBe('unknown');
  });
  it('keeps chronically empty sources unknown without evidence of healthy parsing', () => {
    // Median 0 and newest 0: nothing has regressed, the source simply has
    // nothing to report. Alarming here would cry wolf on every run.
    expect(sourceStatus(undefined, [0, 0, 0, 0])).toBe('unknown');
  });
});

// ──────────────────────────────────────────────────────────────────────────

const EMPTY_BREAKDOWN = {} as ScoreBreakdown;
function sig(over: Partial<Signal> & { ticker: string; score: number }): Signal {
  return {
    convictionLevel: over.score >= 80 ? 'HIGH' : over.score >= 50 ? 'WATCH' : 'LOW',
    totalDollarVolume: 0,
    insiderCount: 0,
    topInsiderRole: null,
    optionsActivity: [],
    rawTrades: [],
    breakdown: EMPTY_BREAKDOWN,
    scrapedAt: new Date().toISOString(),
    sourceUrls: [],
    ...over,
  } as Signal;
}

describe('evaluateAlertRules — crossing semantics', () => {
  const rule: AlertRule = { id: 1, scope: 'global', condition: 'score_gte', threshold: 70, enabled: true };
  it('fires when the threshold is crossed', () => {
    expect(evaluateAlertRules([rule], [sig({ ticker: 'A', score: 75 })], [sig({ ticker: 'A', score: 60 })], [])).toHaveLength(1);
  });
  it('does not re-fire while it merely stays true', () => {
    expect(evaluateAlertRules([rule], [sig({ ticker: 'A', score: 76 })], [sig({ ticker: 'A', score: 75 })], [])).toHaveLength(0);
  });
  it('fires exactly AT the threshold, not below it', () => {
    expect(evaluateAlertRules([rule], [sig({ ticker: 'A', score: 70 })], [sig({ ticker: 'A', score: 69 })], [])).toHaveLength(1);
    expect(evaluateAlertRules([rule], [sig({ ticker: 'A', score: 69.9 })], [sig({ ticker: 'A', score: 10 })], [])).toHaveLength(0);
  });
  it('a cold start fires nothing', () => {
    expect(evaluateAlertRules([rule], [sig({ ticker: 'A', score: 99 })], [], [])).toHaveLength(0);
  });
  it('a disabled rule never fires', () => {
    expect(evaluateAlertRules([{ ...rule, enabled: false }], [sig({ ticker: 'A', score: 99 })], [sig({ ticker: 'A', score: 1 })], [])).toHaveLength(0);
  });
  it('a rule without an id never fires', () => {
    expect(evaluateAlertRules([{ ...rule, id: undefined }], [sig({ ticker: 'A', score: 99 })], [sig({ ticker: 'A', score: 1 })], [])).toHaveLength(0);
  });
  it('ticker scope filters', () => {
    const r: AlertRule = { id: 2, scope: 'ticker', ticker: 'BBB', condition: 'score_gte', threshold: 70, enabled: true };
    const hits = evaluateAlertRules([r], [sig({ ticker: 'AAA', score: 90 }), sig({ ticker: 'BBB', score: 90 })], [sig({ ticker: 'AAA', score: 10 }), sig({ ticker: 'BBB', score: 10 })], []);
    expect(hits.map((h) => h.ticker)).toEqual(['BBB']);
  });
  it('watchlist scope filters', () => {
    const r: AlertRule = { id: 3, scope: 'watchlist', condition: 'new_combo', enabled: true };
    const hits = evaluateAlertRules(
      [r],
      [sig({ ticker: 'CCC', score: 55, comboSignal: true }), sig({ ticker: 'DDD', score: 55, comboSignal: true })],
      [sig({ ticker: 'CCC', score: 50 }), sig({ ticker: 'DDD', score: 50, comboSignal: true })],
      ['CCC'],
    );
    expect(hits.map((h) => h.ticker)).toEqual(['CCC']);
  });
  it('cluster_gte crosses from both sides', () => {
    const r: AlertRule = { id: 4, scope: 'global', condition: 'cluster_gte', threshold: 3, enabled: true };
    expect(evaluateAlertRules([r], [sig({ ticker: 'E', score: 40, insiderCount: 3 })], [sig({ ticker: 'E', score: 40, insiderCount: 2 })], [])).toHaveLength(1);
    expect(evaluateAlertRules([r], [sig({ ticker: 'E', score: 40, insiderCount: 4 })], [sig({ ticker: 'E', score: 40, insiderCount: 3 })], [])).toHaveLength(0);
  });
});

describe('filterSignals', () => {
  const withDate = (ticker: string, daysAgo: number, over: Partial<Signal> = {}) =>
    sig({ ticker, score: 55, tradeDate: ymd(daysAgo), ...over });

  it('"all" keeps undated signals; a windowed range drops them', () => {
    const undated = sig({ ticker: 'U', score: 55, tradeDate: null, scrapedAt: '' });
    expect(filterSignals([undated], { ...DEFAULT_FILTER, timeRange: 'all' })).toHaveLength(1);
    expect(filterSignals([undated], { ...DEFAULT_FILTER, timeRange: 'week' })).toHaveLength(0);
  });
  it('24h means "today"', () => {
    expect(filterSignals([withDate('A', 0)], { ...DEFAULT_FILTER, timeRange: '24h' })).toHaveLength(1);
    expect(filterSignals([withDate('A', 1)], { ...DEFAULT_FILTER, timeRange: '24h' })).toHaveLength(0);
  });
  it('48h means today + yesterday', () => {
    expect(filterSignals([withDate('A', 1)], { ...DEFAULT_FILTER, timeRange: '48h' })).toHaveLength(1);
    expect(filterSignals([withDate('A', 2)], { ...DEFAULT_FILTER, timeRange: '48h' })).toHaveLength(0);
  });
  it('week means the rolling last 7 calendar days', () => {
    expect(filterSignals([withDate('A', 6)], { ...DEFAULT_FILTER, timeRange: 'week' })).toHaveLength(1);
    expect(filterSignals([withDate('A', 7)], { ...DEFAULT_FILTER, timeRange: 'week' })).toHaveLength(0);
  });
  it('the combo filter accepts politician tiers too', () => {
    const classic = sig({ ticker: 'A', score: 55, tradeDate: ymd(0), comboSignal: true });
    const politicianCombo = sig({
      ticker: 'B', score: 55, tradeDate: ymd(0),
      breakdown: { politicianComboTier: 'MEGA_SIGNAL' } as ScoreBreakdown,
    });
    const neither = withDate('C', 0);
    const out = filterSignals([classic, politicianCombo, neither], { ...DEFAULT_FILTER, type: 'combo' });
    expect(out.map((s) => s.ticker).sort()).toEqual(['A', 'B']);
  });
  it('the openmarket filter requires a full-weight buy', () => {
    const buy = sig({ ticker: 'A', score: 55, tradeDate: ymd(0), rawTrades: [{ transactionType: 'P - Purchase' } as never] });
    const award = sig({ ticker: 'B', score: 55, tradeDate: ymd(0), rawTrades: [{ transactionType: 'A - Award' } as never] });
    expect(filterSignals([buy, award], { ...DEFAULT_FILTER, type: 'openmarket' }).map((s) => s.ticker)).toEqual(['A']);
  });
  it('search matches ticker, company and insider name', () => {
    const s = sig({
      ticker: 'ZZZ', score: 55, tradeDate: ymd(0), companyName: 'Acme Corp',
      rawTrades: [{ insiderName: 'Jane Doe' } as never],
    });
    for (const q of ['zzz', 'acme', 'jane']) {
      expect(filterSignals([s], { ...DEFAULT_FILTER, search: q })).toHaveLength(1);
    }
    expect(filterSignals([s], { ...DEFAULT_FILTER, search: 'nothing' })).toHaveLength(0);
  });
  it('conviction and bigPlayer filters compose', () => {
    const a = sig({ ticker: 'A', score: 85, tradeDate: ymd(0), bigPlayer: true });
    const b = sig({ ticker: 'B', score: 85, tradeDate: ymd(0), bigPlayer: false });
    const out = filterSignals([a, b], { ...DEFAULT_FILTER, conviction: 'HIGH', bigPlayersOnly: true });
    expect(out.map((s) => s.ticker)).toEqual(['A']);
  });
  it('never mutates the input array', () => {
    const list = [withDate('A', 0), withDate('B', 30)];
    const before = JSON.stringify(list);
    filterSignals(list, DEFAULT_FILTER);
    expect(JSON.stringify(list)).toBe(before);
  });
});

describe('isComboSignal', () => {
  it('is true for the classic combo and for every politician tier', () => {
    expect(isComboSignal(sig({ ticker: 'A', score: 1, comboSignal: true }))).toBe(true);
    expect(isComboSignal(sig({ ticker: 'A', score: 1, breakdown: { politicianComboTier: 'POLITICIAN_OPTIONS' } as ScoreBreakdown }))).toBe(true);
  });
  it('is false otherwise', () => {
    expect(isComboSignal(sig({ ticker: 'A', score: 1 }))).toBe(false);
  });
});

describe('big-player classification', () => {
  it('uses the static list case-insensitively', () => {
    expect(isBigPlayer('aapl')).toBe(true);
    expect(isBigPlayer(' MSFT ')).toBe(true);
    expect(isBigPlayer('NOTATICKER')).toBe(false);
    expect(isBigPlayer('')).toBe(false);
  });
  it('a $10B+ market cap wins over the list', () => {
    expect(isBigPlayerByCap('NOTATICKER', 20e9)).toBe(true);
    expect(isBigPlayerByCap('NOTATICKER', 1e9)).toBe(false);
    expect(isBigPlayerByCap('AAPL', 1e9)).toBe(true); // list fallback
  });
  it('the $10B boundary from both sides', () => {
    expect(isBigPlayerByCap('X', 10_000_000_000)).toBe(true);
    expect(isBigPlayerByCap('X', 9_999_999_999)).toBe(false);
  });
});

describe('source metadata helpers', () => {
  it('an ungated source is always unlocked', () => {
    expect(isSourceUnlocked('openinsider', {})).toBe(true);
  });
  it('a gated source needs a login', () => {
    expect(isSourceUnlocked('optionstrat', {})).toBe(false);
    expect(isSourceUnlocked('optionstrat', { optionstrat: { loggedIn: true, savedAt: null } })).toBe(true);
  });
  it('sourceLabel resolves main sources, side pipelines and unknown keys', () => {
    expect(sourceLabel('openinsider')).toBe('OpenInsider');
    expect(sourceLabel('capitoltrades')).toBe('Congressional Trades');
    expect(sourceLabel('made-up')).toBe('made-up');
  });
});

describe('dropRate (data-quality monitor)', () => {
  const stat = (over: Partial<import('../src/types').DataQualityStat> = {}) => ({
    rows: 0, badTicker: 0, repairedTicker: 0, badDate: 0, noValue: 0, unknownType: 0, noRole: 0, ...over,
  });
  it('an empty run has no drop rate', () => {
    expect(dropRate(stat())).toBe(0);
  });
  it('sums the three hard drop reasons', () => {
    expect(dropRate(stat({ rows: 100, badTicker: 5, badDate: 3, noValue: 2 }))).toBeCloseTo(0.1, 10);
  });
  it('ignores the soft counters (unknown type / missing role are kept rows)', () => {
    expect(dropRate(stat({ rows: 100, unknownType: 40, noRole: 60 }))).toBe(0);
  });
  it('is capped at 1 even if reasons overlap on the same row', () => {
    expect(dropRate(stat({ rows: 10, badTicker: 10, badDate: 10, noValue: 10 }))).toBe(1);
  });
});
