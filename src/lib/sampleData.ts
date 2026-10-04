import type {
  Signal,
  ScrapeLogEntry,
  WatchlistItem,
  OptionsActivity,
  RawInsiderTrade,
  InsiderTrackRecord,
  ScoreBreakdown,
  PoliticianTrade,
  PoliticianComboTier,
  PortfolioState,
  PortfolioEquityPoint,
  PortfolioPosition,
} from '@/types';
import { DEFAULT_PORTFOLIO_CONFIG } from '@/types';
import { computeStats, toClosedPosition, toOpenPosition } from './portfolio-rules';

/**
 * Sample data used ONLY in browser preview mode (when not running inside
 * Electron). It lets the extended UI be explored without the desktop shell.
 */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

interface SampleOpts {
  ticker: string;
  company: string;
  score: number;
  volume: number;
  insiders: number;
  role: string;
  name: string;
  rank: number;
  cluster: number;
  ageDays: number;
  combo?: boolean;
  daysToEarnings?: number;
  optionsScore?: number;
  lateFiling?: boolean;
  confidence?: number;
  sells?: number;
  form144?: number;
  shortPctFloat?: number;
  floatShares?: number;
  avgDollarVolume?: number;
  pctFrom52wHigh?: number;
  politicians?: PoliticianTrade[];
  politicianScore?: number;
  politicianComboTier?: PoliticianComboTier | null;
}

function buildSignal(o: SampleOpts): Signal {
  const level = o.score >= 80 ? 'HIGH' : o.score >= 50 ? 'WATCH' : 'LOW';
  const dvPoints = o.volume > 5_000_000 ? 20 : o.volume >= 1_000_000 ? 14 : o.volume >= 500_000 ? 10 : 5;
  const freshness = o.ageDays < 1 ? 1 : o.ageDays <= 3 ? 0.85 : o.ageDays <= 7 ? 0.7 : o.ageDays <= 14 ? 0.4 : 0.2;
  const tradeDate = isoDaysAgo(o.ageDays);
  const filingDate = isoDaysAgo(Math.max(0, o.ageDays - (o.lateFiling ? 8 : 1)));
  const optionsScore = o.optionsScore ?? 0;

  const options: OptionsActivity[] =
    optionsScore > 0
      ? [
          {
            ticker: o.ticker,
            type: 'call',
            sentiment: 'bullish',
            notional: optionsScore >= 14 ? 1_800_000 : 720_000,
            premiumTotal: optionsScore >= 14 ? 1_800_000 : 720_000,
            strike: 220,
            currentPrice: 198,
            otmPercent: 11.1,
            expiry: isoDaysAgo(-14),
            dte: 14,
            volume: 8200,
            openInterest: 950,
            volOiRatio: 8.6,
            isSweep: true,
            source: 'barchart',
          },
        ]
      : [];

  const trades: RawInsiderTrade[] = Array.from({ length: o.insiders }).map((_, i) => {
    const txTypes = ['P - Purchase', 'P - Purchase', '10b5-1 Purchase', 'A - Award'];
    return {
      ticker: o.ticker,
      companyName: o.company,
      insiderName: i === 0 ? o.name : `${['Robert', 'Maria', 'David', 'Susan'][i % 4]} ${['Lin', 'Cole', 'Park', 'Reed'][i % 4]}`,
      role: i === 0 ? o.role : ['Director', 'CFO', 'VP Finance', 'Director'][i % 4],
      transactionType: txTypes[i % txTypes.length],
      tradeDate: isoDaysAgo(o.ageDays + i),
      filingDate,
      shares: 5000 - i * 700,
      price: 180 + i,
      value: Math.round(o.volume / o.insiders),
      source: 'openinsider',
      sourceUrl: 'http://openinsider.com/latest-insider-purchases-25k',
      insiderUrl: `http://openinsider.com/insider/${o.name.replace(/\s+/g, '-')}/100000${i}`,
    };
  });

  const breakdown: ScoreBreakdown = {
    rankWeight: o.rank,
    dollarVolumePoints: dvPoints,
    typeModifier: 0.95,
    clusterMultiplier: o.cluster,
    timingMultiplier: o.daysToEarnings != null && o.daysToEarnings <= 5 ? 1.8 : o.daysToEarnings != null && o.daysToEarnings <= 15 ? 1.5 : 1,
    optionsScore,
    optionsTimingMultiplier: o.daysToEarnings != null && o.daysToEarnings <= 5 ? 2 : 1,
    freshnessMultiplier: freshness,
    vixMultiplier: 1,
    trackRecordMultiplier: 1,
    valuationMultiplier: 1,
    comboBonus: o.combo ? 30 : 0,
    optionsBonus: optionsScore,
    signalAgeDays: o.ageDays,
    rawScore: o.rank * dvPoints * o.cluster,
    maxPossibleRaw: 2126,
    normalizedScore: o.score,
    confidence: o.confidence,
    politicianScore: o.politicianScore,
    politicianComboTier: o.politicianComboTier ?? null,
    notes: [
      ...(o.cluster > 1 ? [`${o.insiders} insiders buying (cluster ×${o.cluster})`] : []),
      ...(o.daysToEarnings != null && o.daysToEarnings <= 15 ? ['Buying pre-earnings'] : []),
      ...(o.combo ? ['⚡ COMBO: insider buying + unusual options flow (+30)'] : []),
    ],
  };

  return {
    ticker: o.ticker,
    companyName: o.company,
    score: o.score,
    convictionLevel: level,
    totalDollarVolume: o.volume,
    insiderCount: o.insiders,
    topInsiderRole: o.role,
    topInsiderName: o.name,
    optionsActivity: options,
    rawTrades: trades,
    breakdown,
    scrapedAt: new Date().toISOString(),
    sourceUrls: ['http://openinsider.com/latest-insider-purchases-25k', 'https://finviz.com/insidertrading.ashx'],
    tradeDate,
    filingDate,
    lateFiling: !!o.lateFiling,
    comboSignal: !!o.combo,
    comboDetectedAt: o.combo ? new Date().toISOString() : null,
    earningsDate: o.daysToEarnings != null ? isoDaysAgo(-o.daysToEarnings) : null,
    earningsTiming: o.daysToEarnings != null ? 'AMC' : null,
    daysToEarnings: o.daysToEarnings ?? null,
    insiderFlow:
      o.sells != null || o.form144 != null
        ? { buys: o.volume, sells: o.sells ?? 0, form144: o.form144 ?? 0 }
        : null,
    stats:
      o.shortPctFloat != null || o.floatShares != null || o.avgDollarVolume != null || o.pctFrom52wHigh != null
        ? {
            shortPctFloat: o.shortPctFloat,
            floatShares: o.floatShares,
            avgDollarVolume: o.avgDollarVolume,
            pctFrom52wHigh: o.pctFrom52wHigh,
          }
        : null,
    politicianScore: o.politicianScore,
    politicianTrades: o.politicians ?? [],
  };
}

/** Compact helper to build a sample politician trade. */
function pol(
  politician: string,
  chamber: 'House' | 'Senate',
  party: string,
  type: 'buy' | 'sell',
  amt: number,
  ageDays: number,
  daysToDisclose: number,
  committee?: string,
): PoliticianTrade {
  return {
    politician,
    chamber,
    party,
    committee,
    ticker: 'SAMPLE',
    transactionType: type,
    amountMidpoint: amt,
    tradeDate: isoDaysAgo(ageDays),
    disclosureDate: isoDaysAgo(Math.max(0, ageDays - daysToDisclose)),
    daysToDisclose,
    scrapedAt: new Date().toISOString(),
  };
}

export const sampleSignals: Signal[] = [
  buildSignal({ ticker: 'NVDA', company: 'NVIDIA Corp.', score: 100, volume: 8_400_000, insiders: 4, role: 'Chief Executive Officer', name: 'Jensen Huang', rank: 10, cluster: 3, ageDays: 0, combo: true, daysToEarnings: 4, optionsScore: 18, confidence: 96, sells: 0, floatShares: 24_500_000_000, avgDollarVolume: 41_000_000_000, pctFrom52wHigh: -8,
    politicianScore: 62, politicianComboTier: 'MEGA_SIGNAL',
    politicians: [
      pol('Nancy Pelosi', 'House', 'Democrat', 'buy', 175_000, 3, 12, 'Finance'),
      pol('Tommy Tuberville', 'Senate', 'Republican', 'buy', 750_000, 5, 28, 'Armed Services'),
      pol('Ro Khanna', 'House', 'Democrat', 'buy', 32_500, 6, 9, 'Science'),
    ] }),
  buildSignal({ ticker: 'AAPL', company: 'Apple Inc.', score: 84, volume: 3_100_000, insiders: 3, role: 'Chief Financial Officer', name: 'Luca Maestri', rank: 8, cluster: 2, ageDays: 2, daysToEarnings: 12, optionsScore: 9, confidence: 78, sells: 640_000, floatShares: 14_660_000_000, avgDollarVolume: 12_000_000_000, pctFrom52wHigh: -14,
    politicianScore: 30, politicianComboTier: 'POLITICIAN_INSIDER',
    politicians: [
      pol('John Boozman', 'Senate', 'Republican', 'buy', 32_500, 8, 34),
      pol('Josh Gottheimer', 'House', 'Democrat', 'sell', 75_000, 4, 15),
    ] }),
  buildSignal({ ticker: 'JPM', company: 'JPMorgan Chase & Co.', score: 58, volume: 2_250_000, insiders: 2, role: 'Director', name: 'Mary Erdoes', rank: 4, cluster: 1.5, ageDays: 5, lateFiling: true, optionsScore: 14, confidence: 62, sells: 6_800_000, form144: 3, pctFrom52wHigh: -3 }),
  buildSignal({ ticker: 'RIVN', company: 'Rivian Automotive', score: 51, volume: 1_400_000, insiders: 2, role: 'Chief Technology Officer', name: 'Drew Baglino', rank: 6, cluster: 1.5, ageDays: 10, daysToEarnings: 22, confidence: 55, sells: 120_000, shortPctFloat: 24.5, floatShares: 900_000_000, avgDollarVolume: 380_000_000, pctFrom52wHigh: -62 }),
  buildSignal({ ticker: 'MSFT', company: 'Microsoft Corp.', score: 38, volume: 980_000, insiders: 1, role: 'President', name: 'Brad Smith', rank: 8, cluster: 1, ageDays: 6, optionsScore: 9, confidence: 44 }),
  buildSignal({ ticker: 'PLTR', company: 'Palantir Technologies', score: 29, volume: 540_000, insiders: 1, role: 'Director', name: 'Alex Karp', rank: 4, cluster: 1, ageDays: 16, confidence: 40, shortPctFloat: 8, avgDollarVolume: 340_000, pctFrom52wHigh: -45 }),
];

export const sampleWatchlist: WatchlistItem[] = [
  { id: 1, ticker: 'NVDA', addedAt: new Date(Date.now() - 86400000).toISOString(), notes: 'cluster buy', signal: sampleSignals[0] },
  { id: 2, ticker: 'AAPL', addedAt: new Date(Date.now() - 172800000).toISOString(), notes: null, signal: sampleSignals[1] },
];

// Six recent runs where "finviz" has silently died (healthy history → 0 rows
// for the last two runs) so the health banner + panel demonstrate the states.
export const sampleLogs: ScrapeLogEntry[] = [0, 1, 2, 3, 4, 5].map((i) => ({
  id: 30 - i,
  startedAt: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
  finishedAt: new Date(Date.now() - (i + 1) * 3600_000 + 100_000).toISOString(),
  sourcesScraped: ['edgar', 'openinsider', 'finviz', 'barchart'],
  signalsFound: 6 - i,
  status: i === 0 ? 'partial' : 'success',
  vixAtScrape: 22.4 - i * 0.3,
  sourceBreakdown: {
    edgar: 40 - i,
    openinsider: 120 - i * 3,
    finviz: i <= 1 ? 0 : 22 - i, // dead in the two most recent runs
    barchart: 18 - i,
  },
}));

export function sampleTrackRecord(name: string): InsiderTrackRecord {
  const seed = name.length % 4;
  const total = 9 + seed;
  const prof = Math.round(total * (0.55 + seed * 0.08));
  const outcomes = [true, true, false, true, true, true, false, true].map((b, i) => (i + seed) % 5 === 0 ? !b : b);
  return {
    insiderName: name,
    insiderRole: 'Chief Executive Officer',
    totalTrades: total,
    profitable3m: prof,
    profitable6m: Math.max(prof - 1, 0),
    accuracy3m: prof / total,
    accuracy6m: Math.max(prof - 1, 0) / total,
    avgReturn3m: Math.round((4 + seed * 3.5) * 10) / 10,
    lastUpdated: new Date().toISOString(),
    recentTrades: outcomes.map((ok, i) => ({
      tradeDate: isoDaysAgo(120 - i * 12),
      ticker: ['NVDA', 'AMD', 'AAPL', 'MSFT'][i % 4],
      transactionType: 'P - Purchase',
      purchasePrice: 100 + i * 5,
      return3m: ok ? 8 + i : -(3 + (i % 4)),
      wasProfitable3m: ok,
      wasProfitable6m: ok,
    })),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Testing portfolio — preview only
// ──────────────────────────────────────────────────────────────────────────

/**
 * A deterministic sample curve for the vite-preview shell, which has neither a
 * database nor a published JSON to read.
 *
 * Marked `available` but with an explicit note: the tab has to LOOK like the
 * real thing so the layout can be judged, while never letting a reader mistake
 * invented numbers for measured ones. The seeded pseudo-random walk keeps it
 * stable across reloads — a curve that changed on every refresh would be the
 * one part of this feature that is obviously fake.
 */
export function samplePortfolio(): PortfolioState {
  const config = DEFAULT_PORTFOLIO_CONFIG;
  const DAYS = 90;
  // Mulberry32: tiny, seeded, and identical in every browser.
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const equity: PortfolioEquityPoint[] = [];
  let pv = config.startingCash;
  let bv = config.startingCash;
  for (let i = 0; i < DAYS; i++) {
    const date = isoDaysAgo(DAYS - i);
    const market = (rnd() - 0.47) * 0.011;
    bv *= 1 + market;
    pv *= 1 + market + (rnd() - 0.45) * 0.006;
    const positionsValue = i > 12 ? pv * 0.12 : 0;
    const spyCashValue = pv - positionsValue;
    equity.push({
      date,
      cash: 0,
      spyCashValue: Math.round(spyCashValue * 100) / 100,
      positionsValue: Math.round(positionsValue * 100) / 100,
      equity: Math.round((spyCashValue + positionsValue) * 100) / 100,
      equityIdle: Math.round(pv * 0.96 * 100) / 100,
      benchmark: Math.round(bv * 100) / 100,
      openPositions: i > 12 ? 2 : 0,
    });
  }

  const raw: PortfolioPosition[] = [
    ['NVDA', 78.2, 62, 32, 118.4, 141.2, 'take_profit'],
    ['AMD', 75.1, 55, 25, 152.6, 137.1, 'stop_loss'],
    ['LLY', 81.0, 40, 10, 742.1, 803.5, 'trailing'],
    ['CRM', 74.4, 20, null, 268.0, null, null],
  ].map((r, i) => {
    const [ticker, score, agoIn, agoOut, entry, exit, reason] = r as [
      string,
      number,
      number,
      number | null,
      number,
      number | null,
      PortfolioPosition['exitReason'],
    ];
    const weight = Math.min(config.maxWeight, config.baseWeight * (1 + (score - config.entryScore) / config.scoreSpan));
    const shares = (config.startingCash * weight) / entry;
    return {
      id: i + 1,
      ticker,
      signalId: null,
      entryDate: isoDaysAgo(agoIn),
      entryPrice: entry,
      shares,
      costBasis: shares * entry,
      entryScore: score,
      targetWeight: weight,
      highWaterClose: Math.max(entry, exit ?? entry) * 1.04,
      exitDate: agoOut == null ? null : isoDaysAgo(agoOut),
      exitPrice: exit,
      exitReason: reason,
      realizedPnl: exit == null ? null : shares * exit - shares * entry,
      spyEntry: 500,
      spyExit: exit == null ? null : 512,
    };
  });

  const last = equity[equity.length - 1];
  const closed = raw.filter((p) => p.exitDate).map(toClosedPosition);
  const open = raw
    .filter((p) => !p.exitDate)
    .map((p) => toOpenPosition(p, p.entryPrice * 1.06, last.date, last.equity, config));

  return {
    config,
    meta: {
      available: true,
      firstDate: equity[0].date,
      lastDate: last.date,
      backfillStart: equity[0].date,
      liveStart: equity[30].date,
      lastRun: new Date().toISOString(),
      skippedNoCash: 1,
      skippedCap: 0,
      missingPrices: 2,
      suspectPrices: 0,
      untradableTickers: ['DELISTED'],
      restatedDays: 0,
      priceAsOf: last.date,
      readOnly: true,
      note: 'Preview mode — this curve is generated sample data, not a measured result.',
    },
    equity,
    open,
    closed,
    events: [
      { date: last.date, kind: 'buy', ticker: 'CRM', score: 74.4, amount: 512.3, note: null },
      { date: equity[60].date, kind: 'skipped_no_cash', ticker: 'ABNB', score: 76.1, amount: 42.5, note: 'preview' },
    ],
    stats: computeStats(equity, closed, open, config),
  };
}
