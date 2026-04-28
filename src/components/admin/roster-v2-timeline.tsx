'use client';

import type { RosterCycle } from '@/server/api/routers/roster';
import { CONTENT_TYPE_DOT, PHASE_FILL, PHASE_STROKE, dayOffset } from './roster-v2-shared';

interface InlineTimelineProps {
  cycles: RosterCycle[];
  /** Total days the strip spans, ending at "today" on the right edge. */
  days?: number;
  height?: number;
  dotSize?: number;
}

/**
 * 120-day inline timeline: one strip per CEO row showing all their cycles
 * (positioned by date) and submission dots (one per matched raw_input).
 * Today's edge is the right end with a dashed marker.
 */
export function InlineTimeline({
  cycles,
  days = 120,
  height = 28,
  dotSize = 7,
}: InlineTimelineProps) {
  const today = new Date();
  const dateToPct = (iso: string) => {
    const d = new Date(iso);
    const offset = (today.getTime() - d.getTime()) / 86_400_000;
    return ((days - offset) / days) * 100;
  };

  return (
    <div
      className="relative rounded border bg-muted/30"
      style={{ height, borderColor: 'var(--border)' }}
    >
      {/* Today marker on the right edge */}
      <div
        className="pointer-events-none absolute right-0 top-0 bottom-0"
        style={{ borderRight: '1px dashed var(--border)' }}
      />

      {/* Cycle bars */}
      {cycles.map((cy) => {
        if (!cy.periodStart || !cy.periodEnd) return null;
        const left = Math.max(0, dateToPct(cy.periodStart));
        const right = Math.min(100, dateToPct(cy.periodEnd));
        const width = right - left;
        if (width <= 0) return null;
        return (
          <div
            key={cy.id}
            title={`${cy.label} · ${cy.phase}`}
            className="absolute rounded-sm"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              top: 4,
              bottom: 4,
              background: PHASE_FILL[cy.phase],
              border: `1px solid ${PHASE_STROKE[cy.phase]}`,
            }}
          />
        );
      })}

      {/* Submission dots */}
      {cycles.flatMap((cy) =>
        cy.submissions.map((s) => {
          const pct = dateToPct(s.occurredAt);
          if (pct < 0 || pct > 100) return null;
          const color = CONTENT_TYPE_DOT[s.type] ?? 'var(--muted-foreground)';
          const offset = dayOffset(s.occurredAt, today);
          const unconfirmed = s.status.includes('unconfirmed');
          return (
            <span
              key={`${cy.id}-${s.rawInputId}`}
              title={`${s.type} · ${offset}d ago`}
              className="absolute"
              style={{
                left: `${pct}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: dotSize,
                height: dotSize,
                borderRadius: dotSize / 2,
                background: unconfirmed ? 'transparent' : color,
                border: `1.5px solid ${color}`,
                zIndex: 2,
              }}
            />
          );
        })
      )}
    </div>
  );
}
