import { useEffect, useState } from 'react';
import { scoreColor } from '@/lib/format';

interface ScoreGaugeProps {
  score: number;
  size?: number;
  stroke?: number;
  showLabel?: boolean;
  sublabel?: string;
}

/** Animated circular SVG progress ring, color-coded by conviction. */
export function ScoreGauge({
  score,
  size = 120,
  stroke = 10,
  showLabel = true,
  sublabel,
}: ScoreGaugeProps) {
  const [animated, setAnimated] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setAnimated(score), 60);
    return () => clearTimeout(t);
  }, [score]);

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(Math.max(animated, 0), 100);
  const offset = circumference - (clamped / 100) * circumference;
  const color = scoreColor(score);
  const center = size / 2;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--border-glass)"
          strokeWidth={stroke}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`}
          style={{
            transition: 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)',
            filter: `drop-shadow(0 0 6px ${color}55)`,
          }}
        />
      </svg>
      {showLabel && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-extrabold leading-none font-mono-terminal" style={{ fontSize: size * 0.3, color }}>
            {Math.round(score)}
          </span>
          {sublabel && (
            <span
              className="mt-0.5 font-semibold uppercase tracking-wider text-secondary"
              style={{ fontSize: size * 0.1 }}
            >
              {sublabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
