'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * Tiny inline sparkline for KPI rows. SVG-based, zero dependencies.
 * Skips render when fewer than 2 numeric points exist (one point is
 * a snapshot, not a trend) and bails to a muted "no series" hint.
 *
 *  - Values that don't parse as numbers (e.g. "two finalist banks") are
 *    dropped — sparkline math doesn't apply.
 *  - The last point is highlighted with a filled dot so the eye lands
 *    on "where we are now".
 *  - Min/max are computed from the visible points so the line uses the
 *    full vertical range; absolute scale isn't meaningful at this size.
 */
export function KpiSparkline({
  series,
  width = 96,
  height = 22,
  className,
}: {
  series: Array<{ value: string }>;
  width?: number;
  height?: number;
  className?: string;
}) {
  const points = useMemo(() => {
    const numeric = series
      .map((s) => parseNumeric(s.value))
      .filter((n): n is number => n !== null);
    return numeric;
  }, [series]);

  if (points.length < 2) {
    return (
      <span className={cn('text-[10px] italic text-muted-foreground/70', className)}>
        no series yet
      </span>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = points.length === 1 ? 0 : width / (points.length - 1);

  const xy = points.map((p, i) => {
    const x = i * stepX;
    // Pad 2px top/bottom so the dot/line never clips the box.
    const y = height - 2 - ((p - min) / range) * (height - 4);
    return [x, y];
  });
  const path = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1];
  const first = xy[0];
  const finalDelta = points[points.length - 1] - points[0];
  // "Up" / "down" / "flat" classification mirrors the editor's
  // deriveTrend rule (1% threshold).
  const denom = Math.abs(points[0]) || 1;
  const pct = finalDelta / denom;
  const tone = pct > 0.01 ? 'up' : pct < -0.01 ? 'down' : 'flat';
  const stroke =
    tone === 'up'
      ? 'oklch(55% 0.12 152)'
      : tone === 'down'
        ? 'oklch(58% 0.18 27)'
        : 'var(--muted-foreground)';

  return (
    <svg
      role="img"
      aria-label={`Sparkline of ${points.length} points, ${tone}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 align-middle', className)}
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={first[0]} cy={first[1]} r={1.5} fill="var(--muted-foreground)" opacity={0.6} />
      <circle cx={last[0]} cy={last[1]} r={2} fill={stroke} />
    </svg>
  );
}

function parseNumeric(input: string | undefined | null): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/[$£€,]/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(k|m|mm|bn|b)?\s*%?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2];
  if (!mult) return n;
  if (mult === 'k') return n * 1_000;
  if (mult === 'm' || mult === 'mm') return n * 1_000_000;
  if (mult === 'b' || mult === 'bn') return n * 1_000_000_000;
  return n;
}
