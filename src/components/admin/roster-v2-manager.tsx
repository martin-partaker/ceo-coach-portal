'use client';

import Link from 'next/link';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import type { RosterCeoSummary, RosterCycle } from '@/server/api/routers/roster';
import {
  CONTENT_TYPE_DOT,
  PHASE_DOT,
  PHASE_FILL,
  PHASE_STROKE,
} from './roster-v2-shared';

interface Props {
  summaries: RosterCeoSummary[];
  /** Total days the lane spans, ending at "today" on the right edge. */
  days?: number;
}

const ROW_HEIGHT = 56;
const LANE_PADDING_X = 14;
const NAME_COL_WIDTH = 220;

/**
 * Manager mode — a Gantt-style cross-coach timeline. Each row is a CEO,
 * cycles are bars positioned by date, phase-coloured. Submission dots
 * appear inside each bar so cadence is legible at a glance.
 */
export function RosterV2Manager({ summaries, days = 120 }: Props) {
  // Group by coach, ordered alphabetically. Each coach is a sub-section
  // header so the page reads top-down.
  const grouped = (() => {
    const m = new Map<string, { coach: RosterCeoSummary['coach']; rows: RosterCeoSummary[] }>();
    for (const s of summaries) {
      const slot = m.get(s.coach.id);
      if (slot) slot.rows.push(s);
      else m.set(s.coach.id, { coach: s.coach, rows: [s] });
    }
    return [...m.values()].sort((a, b) => a.coach.name.localeCompare(b.coach.name));
  })();

  if (summaries.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {/* Header */}
      <div
        className="grid items-center border-b border-border bg-muted/30 py-2"
        style={{ gridTemplateColumns: `${NAME_COL_WIDTH}px 1fr` }}
      >
        <div className="px-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          CEO · Coach
        </div>
        <ManagerHeader days={days} />
      </div>

      {/* Coach sections */}
      {grouped.map(({ coach, rows }, gi) => (
        <div key={coach.id}>
          {gi > 0 && <div className="h-px bg-border" />}
          <div
            className="grid items-center border-b border-border bg-muted/20 py-1.5"
            style={{ gridTemplateColumns: `${NAME_COL_WIDTH}px 1fr` }}
          >
            <div className="px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {coach.name}
              <span className="ml-2 font-mono normal-case text-muted-foreground/70">
                · {rows.length} CEO{rows.length === 1 ? '' : 's'}
              </span>
            </div>
            <div />
          </div>
          {rows.map((s) => (
            <CeoRow key={s.ceo.id} summary={s} days={days} />
          ))}
        </div>
      ))}

      {/* Phase legend */}
      <div className="flex items-center gap-3 border-t border-border bg-muted/30 px-4 py-2 text-[11px]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          phase
        </span>
        {(['gathering', 'ready', 'generated', 'sent', 'idle'] as const).map((p) => (
          <span key={p} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{ background: PHASE_FILL[p], border: `1px solid ${PHASE_STROKE[p]}` }}
            />
            <span className="capitalize text-muted-foreground">{p}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function CeoRow({ summary, days }: { summary: RosterCeoSummary; days: number }) {
  return (
    <div
      className="grid items-stretch border-b border-border last:border-b-0"
      style={{
        gridTemplateColumns: `${NAME_COL_WIDTH}px 1fr`,
        minHeight: ROW_HEIGHT,
      }}
    >
      <Link
        href={`/ceos/${summary.ceo.id}`}
        className="flex items-center gap-2.5 border-r border-border px-3 transition-colors hover:bg-muted/30"
      >
        <CeoAvatar name={summary.ceo.name} avatarUrl={summary.ceo.avatarUrl} size="sm" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{summary.ceo.name}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {summary.cycles.length} cycle{summary.cycles.length === 1 ? '' : 's'}
          </div>
        </div>
      </Link>
      <ManagerLane cycles={summary.cycles} ceoId={summary.ceo.id} days={days} />
    </div>
  );
}

function ManagerHeader({ days }: { days: number }) {
  const today = new Date();
  const months: Array<{ pct: number; label: string }> = [];
  for (let d = days; d >= 0; d -= 1) {
    const date = new Date(today.getTime() - d * 86_400_000);
    if (date.getDate() === 1) {
      months.push({
        pct: ((days - d) / days) * 100,
        label: date.toLocaleString('en', { month: 'long' }),
      });
    }
  }
  return (
    <div
      className="relative"
      style={{ height: 18, paddingLeft: LANE_PADDING_X, paddingRight: LANE_PADDING_X }}
    >
      {months.map((m, i) => (
        <div
          key={i}
          className="absolute top-0 font-mono text-[10px] font-medium text-foreground/80"
          style={{ left: `calc(${m.pct}% + ${LANE_PADDING_X}px)` }}
        >
          {m.label}
        </div>
      ))}
    </div>
  );
}

function ManagerLane({
  cycles,
  ceoId,
  days,
}: {
  cycles: RosterCycle[];
  ceoId: string;
  days: number;
}) {
  const today = new Date();
  const dateToPct = (iso: string) => {
    const d = new Date(iso);
    const offset = (today.getTime() - d.getTime()) / 86_400_000;
    return ((days - offset) / days) * 100;
  };

  return (
    <div
      className="relative"
      style={{
        height: ROW_HEIGHT,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: LANE_PADDING_X,
        paddingRight: LANE_PADDING_X,
      }}
    >
      {/* Today marker */}
      <div
        className="pointer-events-none absolute top-0 bottom-0"
        style={{
          right: LANE_PADDING_X,
          borderRight: '1.5px dashed oklch(58% 0.14 258)',
        }}
      />

      {cycles.map((cy) => {
        if (!cy.periodStart || !cy.periodEnd) return null;
        const left = Math.max(0, dateToPct(cy.periodStart));
        const right = Math.min(100, dateToPct(cy.periodEnd));
        const width = right - left;
        if (width <= 0) return null;

        return (
          <Link
            key={cy.id}
            href={`/ceos/${ceoId}/cycles/${cy.id}`}
            title={`${cy.label} · ${cy.phase}`}
            className="absolute overflow-hidden rounded transition-shadow hover:shadow-md"
            style={{
              left: `calc(${left}% + ${LANE_PADDING_X}px)`,
              width: `${width}%`,
              top: 8,
              height: ROW_HEIGHT - 16,
              background: PHASE_FILL[cy.phase],
              border: `1px solid ${PHASE_STROKE[cy.phase]}`,
              padding: '4px 8px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            <div
              className="truncate text-[11px] font-medium"
              style={{ color: PHASE_DOT[cy.phase] }}
            >
              {cy.label}
            </div>
            <div className="flex items-center gap-1">
              {cy.submissions.slice(0, 12).map((s) => {
                const color = CONTENT_TYPE_DOT[s.type] ?? 'var(--muted-foreground)';
                const unconfirmed = s.status.includes('unconfirmed');
                return (
                  <span
                    key={s.rawInputId}
                    title={s.type}
                    className="inline-block shrink-0"
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 3,
                      background: unconfirmed ? 'transparent' : color,
                      border: `1px solid ${color}`,
                    }}
                  />
                );
              })}
              {cy.submissions.length > 12 && (
                <span className="ml-0.5 font-mono text-[9px] text-muted-foreground">
                  +{cy.submissions.length - 12}
                </span>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
