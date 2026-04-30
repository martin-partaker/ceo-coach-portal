'use client';

import type { RosterCycle } from '@/server/api/routers/roster';
import {
  CONTENT_TYPE_DOT,
  CONTENT_TYPE_LABEL,
  PHASE_FILL,
  PHASE_STROKE,
  dayOffset,
  fmtShortDate,
  relativeDay,
} from './roster-v2-shared';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface InlineTimelineProps {
  cycles: RosterCycle[];
  /** Total days the strip spans, ending at "today" on the right edge. */
  days?: number;
  height?: number;
  dotSize?: number;
  /** When set, the matching cycle bar is rendered with a focus ring so the
   *  user can see which cycle is currently being worked on in the expanded
   *  panel below. */
  highlightCycleId?: string | null;
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
  highlightCycleId,
}: InlineTimelineProps) {
  const today = new Date();
  const dateToPct = (iso: string) => {
    const d = new Date(iso);
    const offset = (today.getTime() - d.getTime()) / 86_400_000;
    return ((days - offset) / days) * 100;
  };

  return (
    <TooltipProvider delayDuration={150}>
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
          const active = highlightCycleId === cy.id;
          return (
            <div
              key={cy.id}
              title={`${cy.label} · ${cy.phase}`}
              className="absolute rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top: 2,
                bottom: 2,
                background: PHASE_FILL[cy.phase],
                border: active
                  ? '1.5px solid var(--foreground)'
                  : `1px solid ${PHASE_STROKE[cy.phase]}`,
                boxShadow: active
                  ? '0 0 0 2px color-mix(in oklab, var(--foreground), transparent 80%)'
                  : undefined,
                zIndex: active ? 1 : 0,
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
            const unconfirmed = s.status.includes('unconfirmed');
            const typeLabel = CONTENT_TYPE_LABEL[s.type] ?? s.type;
            const sourceLabel =
              s.source === 'zoom' ? 'Zoom' : s.source === 'tally' ? 'Tally' : s.source;
            const date = fmtShortDate(s.occurredAt.slice(0, 10));
            const rel = relativeDay(dayOffset(s.occurredAt, today));
            return (
              <Tooltip key={`${cy.id}-${s.rawInputId}`}>
                <TooltipTrigger asChild>
                  <span
                    className="absolute cursor-help"
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
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[260px]">
                  <div className="space-y-0.5">
                    <div className="font-medium">{typeLabel}</div>
                    <div className="font-mono text-[10px] opacity-80">
                      {sourceLabel} · {date} · {rel}
                    </div>
                    <div className="font-mono text-[10px] opacity-60">{cy.label}</div>
                    {unconfirmed && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-background/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider">
                        unconfirmed — needs review
                      </div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })
        )}
      </div>
    </TooltipProvider>
  );
}
