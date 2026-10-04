import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';

const ACCENT_BLUE = '#0a84ff';
const GRID = 'rgba(128,128,128,0.18)';

export interface ScoreTrendPoint {
  time: string;
  score: number;
}

/**
 * Score-trend chart, split into its own module so Recharts (~100 kB of the
 * bundle) is fetched lazily by the one view that draws it instead of blocking
 * first paint of the alerts list.
 *
 * `compact` drops the grid, thins the ticks and hides the Y axis — on a 360px
 * screen the axis furniture costs more width than it explains.
 */
export function ScoreTrendChart({ data, compact }: { data: ScoreTrendPoint[]; compact: boolean }) {
  return (
    <ResponsiveContainer>
      <LineChart data={data} margin={compact ? { top: 8, right: 8, left: -28, bottom: 0 } : { top: 10, right: 16, left: -8, bottom: 0 }}>
        {!compact && <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />}
        <XAxis
          dataKey="time"
          tick={{ fontSize: compact ? 10 : 11 }}
          stroke={GRID}
          interval="preserveStartEnd"
          minTickGap={compact ? 40 : 5}
        />
        <YAxis domain={[0, 100]} tick={{ fontSize: compact ? 10 : 11 }} stroke={GRID} width={compact ? 28 : 60} />
        <Tooltip />
        <ReferenceLine y={80} stroke="#30d158" strokeDasharray="4 4" />
        <ReferenceLine y={50} stroke="#ffd60a" strokeDasharray="4 4" />
        <Line
          type="monotone"
          dataKey="score"
          stroke={ACCENT_BLUE}
          strokeWidth={2.5}
          dot={{ r: compact ? 2.5 : 3, fill: ACCENT_BLUE }}
          activeDot={{ r: 5 }}
          isAnimationActive
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default ScoreTrendChart;
