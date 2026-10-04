import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Portfolio vs S&P 500 — split out so Recharts (~100 kB) is fetched lazily by
 * the one view that draws it, exactly like ScoreTrendChart.
 *
 * The one thing that makes this comparison fair is that both series sit on ONE
 * shared Y axis and start on the same day at the same amount. Two axes would
 * let any pair of curves be drawn as "beating" the other, which is the single
 * most common way a chart like this lies.
 */

const BLUE = 'var(--portfolio-overlay, var(--accent-blue))';
const GREY = 'var(--portfolio-market, var(--text-secondary))';
const GRID = 'rgba(128,128,128,0.18)';
const GREEN = 'var(--accent-green)';
const RED = 'var(--accent-red)';

/** Most tickers a tooltip lists before it starts counting instead. */
const MAX_TOOLTIP_TRADES = 6;

/**
 * Round a domain outward to a 1/2/5×10^n step, and label it on that same step.
 *
 * Padding the raw min/max produces arbitrary bounds like −4.03% … +5.17%, and
 * Recharts then labels exactly those, so the axis reads with unevenly spaced,
 * meaningless ticks. Snapping to a round step is what makes the vertical
 * distance between the two lines legible at a glance, which is the entire job
 * of the shared axis.
 *
 * The TICKS have to be handed over too, not just the domain. Given a nice
 * −4% … +6% Recharts still divides it into its own five slices and prints
 * −4.0 / −1.5 / +1.0 / +3.5 / +6.0 — a 2.5-point step that no one reads in
 * their head, and which steps straight over zero. On the step itself the same
 * axis reads −4 / −2 / 0 / +2 / +4 / +6, and zero is always a gridline because
 * both bounds are whole multiples of the step.
 */
function niceScale(lo: number, hi: number, targetTicks = 5): { domain: [number, number]; ticks: number[] } {
  const span = hi - lo || Math.max(Math.abs(hi), 1) * 0.02;
  const rough = span / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(rough) || 1));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Rebuilt by MULTIPLICATION rather than by adding `step` in a loop, or
  // 0.1 + 0.1 + 0.1 lands on 0.30000000000000004 and the tick misses zero.
  for (let i = 0; min + i * step <= max + step / 2; i++) ticks.push(min + i * step);
  return { domain: [min, max], ticks };
}

export interface EquityChartPoint {
  date: string;
  portfolio: number;
  benchmark: number;
  idle: number;
}

/**
 * One session's trades. Grouped BY DATE rather than one marker per trade: three
 * trades on 2026-08-31 drew three dots at the same pixel, and keying them by
 * `kind-date` collided in React the moment two of them were the same kind.
 */
export interface TradeMarker {
  date: string;
  value: number;
  buys: string[];
  sells: string[];
}

/** `data` plus the two shaded bands, which are derived and never stored. */
interface BandPoint extends EquityChartPoint {
  ahead: [number, number];
  behind: [number, number];
}

export interface EquityChartProps {
  data: EquityChartPoint[];
  /** '$' plots the NAV, '%' re-bases both series to the same starting capital. */
  unit: '$' | '%';
  logScale: boolean;
  showIdle: boolean;
  portfolioColor?: string;
  markers: TradeMarker[];
  /** Backfill → live boundary, drawn as a vertical rule. */
  liveFrom: string | null;
  /** Axis ticks get their own formatter — a phone has no room for "$10,239.91". */
  formatTick?: (v: number) => string;
  compact: boolean;
  labels: {
    portfolio: string;
    benchmark: string;
    idle: string;
    difference: string;
    liveFrom: string;
    buy: string;
    sell: string;
    more: (n: number) => string;
  };
  formatValue: (v: number) => string;
  formatDate: (d: string) => string;
}

function Row({ color, name, value, faded }: { color: string; name: string; value: string; faded?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4" style={{ opacity: faded ? 0.6 : 1 }}>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: color }} />
        {name}
      </span>
      <span className="tabular-nums font-semibold">{value}</span>
    </div>
  );
}

/**
 * A buy sits BELOW the line pointing up at it, a sell ABOVE pointing down — the
 * standard trading-chart idiom, and the only arrangement where a session that
 * both bought and sold does not draw two marks on one pixel. Recharts clones
 * this element with `cx`/`cy`, so both are optional here.
 */
function TradeMark({ kind, title, cx, cy }: { kind: 'buy' | 'sell'; title: string; cx?: number; cy?: number }) {
  if (cx == null || cy == null) return null;
  const dir = kind === 'buy' ? 1 : -1;
  const apex = cy + dir * 6;
  const base = cy + dir * 13;
  return (
    <path
      d={`M ${cx} ${apex} L ${cx - 4.5} ${base} L ${cx + 4.5} ${base} Z`}
      fill={kind === 'buy' ? GREEN : RED}
      // A 1px halo in the panel colour so a marker sitting ON the line still
      // reads as a separate mark rather than a bulge in the curve.
      stroke="var(--bg-glass)"
      strokeWidth={1}
    >
      <title>{title}</title>
    </path>
  );
}

export function EquityChart({
  data,
  unit,
  logScale,
  showIdle,
  portfolioColor = BLUE,
  markers,
  liveFrom,
  compact,
  labels,
  formatValue,
  formatTick,
  formatDate,
}: EquityChartProps) {
  const values = data.flatMap((d) => [d.portfolio, d.benchmark, ...(showIdle ? [d.idle] : [])]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.06, Math.abs(hi) * 0.004) || 1;
  // Deliberately NOT anchored at zero: over weeks of single-digit moves a
  // zero-based axis squashes a 20% difference into two touching lines.
  // Log needs a strictly positive domain, which the % view (which crosses 0)
  // cannot give — the caller only offers Log in the $ view.
  const scale = niceScale(lo - pad, hi + pad);
  const domain: [number, number] = logScale ? [Math.max(lo * 0.98, 1e-6), hi * 1.02] : scale.domain;

  // The band between the two lines, split by sign: green where the book leads
  // SPY, red where it trails. The losing side collapses to ZERO HEIGHT at the
  // benchmark rather than to null — a null would break the area at every
  // crossing and leave a notch, where a zero-height band lets one colour taper
  // out exactly as the other opens up.
  const series: BandPoint[] = data.map((d) => ({
    ...d,
    ahead: d.portfolio >= d.benchmark ? [d.benchmark, d.portfolio] : [d.benchmark, d.benchmark],
    behind: d.portfolio >= d.benchmark ? [d.benchmark, d.benchmark] : [d.portfolio, d.benchmark],
  }));

  const tradesByDate = new Map(markers.map((m) => [m.date, m]));

  return (
    <ResponsiveContainer>
      <ComposedChart data={series} // The right gutter has to clear HALF the last X label, or 'Aug 31, 2026'
        // is sliced off at the plot edge — 22px still cut it to 'Aug 31, 202' at 393px.
        margin={compact ? { top: 8, right: 34, left: -2, bottom: 0 } : { top: 12, right: 44, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: compact ? 10 : 11 }}
          stroke={GRID}
          interval="preserveStartEnd"
          minTickGap={compact ? 48 : 24}
          tickFormatter={formatDate}
        />
        <YAxis
          domain={domain}
          // Log picks its own decade ticks; the linear scale uses ours.
          ticks={logScale ? undefined : scale.ticks}
          scale={logScale ? 'log' : 'auto'}
          allowDataOverflow
          tick={{ fontSize: compact ? 10 : 11 }}
          stroke={GRID}
          width={compact ? 44 : 68}
          tickFormatter={formatTick ?? formatValue}
        />
        {/* One tooltip for BOTH series, their gap AND the day's trades. The gap
            is the entire question this page asks, so making the reader subtract
            two numbers themselves would hide the answer in plain sight. */}
        <Tooltip
          cursor={{ stroke: GRID }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const point = payload[0].payload as BandPoint;
            const diff = point.portfolio - point.benchmark;
            const trades = tradesByDate.get(point.date);
            const rows = trades
              ? [
                  ...trades.buys.map((tk) => ({ kind: 'buy' as const, ticker: tk })),
                  ...trades.sells.map((tk) => ({ kind: 'sell' as const, ticker: tk })),
                ]
              : [];
            return (
              <div
                className="rounded-xl px-3 py-2 text-xs"
                style={{
                  background: 'var(--bg-glass)',
                  border: '1px solid var(--border-glass)',
                  boxShadow: 'var(--shadow-glass)',
                  backdropFilter: 'blur(20px)',
                }}
              >
                <div className="mb-1 font-semibold">{formatDate(String(label))}</div>
                <Row color={portfolioColor} name={labels.portfolio} value={formatValue(point.portfolio)} />
                <Row color={GREY} name={labels.benchmark} value={formatValue(point.benchmark)} />
                {showIdle && <Row color={BLUE} name={labels.idle} value={formatValue(point.idle)} faded />}
                <div
                  className="mt-1 flex items-center justify-between gap-4 pt-1 font-semibold tabular-nums"
                  style={{
                    borderTop: '1px solid var(--border-glass)',
                    color: diff >= 0 ? GREEN : RED,
                  }}
                >
                  <span>{labels.difference}</span>
                  <span>
                    {diff >= 0 ? '+' : '−'}
                    {formatValue(Math.abs(diff)).replace(/^[+−-]/, '')}
                  </span>
                </div>
                {rows.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5 pt-1" style={{ borderTop: '1px solid var(--border-glass)' }}>
                    {rows.slice(0, MAX_TOOLTIP_TRADES).map((r) => (
                      <div key={`${r.kind}-${r.ticker}`} className="flex items-center gap-1.5">
                        <span style={{ color: r.kind === 'buy' ? GREEN : RED }}>{r.kind === 'buy' ? '▲' : '▼'}</span>
                        <span style={{ color: r.kind === 'buy' ? GREEN : RED }}>
                          {r.kind === 'buy' ? labels.buy : labels.sell}
                        </span>
                        <span className="font-semibold">${r.ticker}</span>
                      </div>
                    ))}
                    {rows.length > MAX_TOOLTIP_TRADES && (
                      <div className="text-secondary">{labels.more(rows.length - MAX_TOOLTIP_TRADES)}</div>
                    )}
                  </div>
                )}
              </div>
            );
          }}
        />
        <Legend
          verticalAlign="top"
          height={compact ? 24 : 30}
          wrapperStyle={{ fontSize: compact ? 11 : 12, color: 'var(--text-secondary)' }}
          // Explicit payload so the PORTFOLIO reads first. The <Line> order is
          // fixed by paint order (benchmark underneath), and the legend would
          // otherwise inherit it and lead with the benchmark.
          payload={[
            { value: labels.portfolio, type: 'line', color: portfolioColor, id: 'portfolio' },
            { value: labels.benchmark, type: 'line', color: GREY, id: 'benchmark' },
            ...(showIdle ? [{ value: labels.idle, type: 'line' as const, color: BLUE, id: 'idle' }] : []),
          ]}
        />
        {/* Flat fills, not gradients. A vertical gradient would shade a band by
            WHERE it sits on the axis rather than how big it is, which is exactly
            the misreading the single shared axis exists to prevent. */}
        <Area
          type="monotone"
          dataKey="ahead"
          stroke="none"
          fill={GREEN}
          fillOpacity={0.16}
          legendType="none"
          isAnimationActive={false}
          activeDot={false}
        />
        <Area
          type="monotone"
          dataKey="behind"
          stroke="none"
          fill={RED}
          fillOpacity={0.16}
          legendType="none"
          isAnimationActive={false}
          activeDot={false}
        />
        {liveFrom && (
          <ReferenceLine
            x={liveFrom}
            stroke={GREY}
            strokeDasharray="2 4"
            label={compact ? undefined : { value: labels.liveFrom, position: 'insideTopRight', fontSize: 10, fill: GREY }}
          />
        )}
        {unit === '%' && <ReferenceLine y={0} stroke={GRID} />}
        <Line
          type="monotone"
          dataKey="benchmark"
          name={labels.benchmark}
          stroke={GREY}
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
        {showIdle && (
          <Line
            type="monotone"
            dataKey="idle"
            name={labels.idle}
            stroke={BLUE}
            strokeOpacity={0.35}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        )}
        <Line
          type="monotone"
          dataKey="portfolio"
          name={labels.portfolio}
          stroke={portfolioColor}
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 5 }}
          isAnimationActive={false}
        />
        {markers.flatMap((m) =>
          (['buy', 'sell'] as const)
            .filter((kind) => (kind === 'buy' ? m.buys : m.sells).length > 0)
            .map((kind) => {
              const tickers = kind === 'buy' ? m.buys : m.sells;
              const word = kind === 'buy' ? labels.buy : labels.sell;
              return (
                <ReferenceDot
                  key={`${kind}-${m.date}`}
                  x={m.date}
                  y={m.value}
                  isFront
                  shape={<TradeMark kind={kind} title={tickers.map((tk) => `${word} $${tk}`).join('\n')} />}
                />
              );
            }),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export default EquityChart;
