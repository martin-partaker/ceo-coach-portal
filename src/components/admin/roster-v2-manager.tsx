'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { TeamAvatars } from '@/components/ui/team-avatars';
import type { RosterCeoSummary, RosterCycle } from '@/server/api/routers/roster';
/** Deduplicated input-type entries for the legend strip. Some
 *  CONTENT_TYPE_LABEL keys collapse to the same display label (e.g.
 *  ten_x_goal + goal_worksheet both show as "10x") — surfacing them
 *  twice in the legend is just noise. The first id in each group is
 *  used to look up the colour. */
const INPUT_LEGEND: Array<{ label: string; types: string[] }> = [
  { label: 'Weekly journal', types: ['weekly_journal'] },
  { label: 'Monthly journal', types: ['monthly_journal'] },
  { label: 'Zoom transcript', types: ['transcript'] },
  { label: '10x / goal worksheet', types: ['ten_x_goal', 'goal_worksheet'] },
  { label: 'Intake', types: ['intake'] },
  { label: 'Self-assessment', types: ['self_assessment'] },
  { label: 'Other', types: ['unknown', 'coach_note', 'fallback_doc', 'support_feedback'] },
];

import {
  CONTENT_TYPE_DOT,
  PHASE_DOT,
  PHASE_FILL,
  PHASE_STROKE,
} from './roster-v2-shared';
import { WorkspaceDrawer } from './workspace-drawer';

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
  const [drawerTarget, setDrawerTarget] = useState<{
    summary: RosterCeoSummary;
    activeCycleId: string;
  } | null>(null);

  function openCycle(summary: RosterCeoSummary, cycleId: string) {
    setDrawerTarget({ summary, activeCycleId: cycleId });
  }

  // Dedupe team members so each team renders as ONE row. The anchor is
  // whichever member appears first in the list; their summary is used
  // as the basis. CRITICAL: we also merge cycles across every team
  // member into the anchor's cycle list (deduped by label) so the
  // joint Gantt shows the team's full timeline, not just the anchor's
  // own cycles. Pre-team data has parallel cycles per period (one per
  // member); collapsing by label gives one visible bar per period.
  const dedupedSummaries = useMemo(() => {
    // Index every summary by teamId so we can find a team's other
    // members in one pass.
    const summariesByTeam = new Map<string, RosterCeoSummary[]>();
    for (const s of summaries) {
      if (!s.ceo.teamId) continue;
      const list = summariesByTeam.get(s.ceo.teamId) ?? [];
      list.push(s);
      summariesByTeam.set(s.ceo.teamId, list);
    }

    const seenTeams = new Set<string>();
    const out: RosterCeoSummary[] = [];
    for (const s of summaries) {
      if (s.ceo.teamId) {
        if (seenTeams.has(s.ceo.teamId)) continue;
        seenTeams.add(s.ceo.teamId);

        // Merge every team member's cycles into one list. Deduped by
        // label: when two members have parallel "Apr 2026" cycles, we
        // pick whichever has more recorded inputs / cycles (richer
        // signal). New cycles created post-team-formation will have
        // a single canonical row anyway — this just handles the
        // pre-team backfilled data cleanly.
        const allMemberCycles = (summariesByTeam.get(s.ceo.teamId) ?? [])
          .flatMap((m) => m.cycles);
        const byLabel = new Map<string, RosterCycle>();
        for (const cy of allMemberCycles) {
          const existing = byLabel.get(cy.label);
          if (!existing) {
            byLabel.set(cy.label, cy);
            continue;
          }
          // Prefer the cycle with more submissions (richer Gantt dots).
          // If tied, prefer the later phase ('generated' > 'ready' >
          // 'gathering' > 'idle' > 'sent' takes precedence in the
          // user's mental model).
          const phasePriority: Record<RosterCycle['phase'], number> = {
            sent: 5,
            generated: 4,
            ready: 3,
            gathering: 2,
            idle: 1,
          };
          const aScore =
            cy.submissions.length * 10 + (phasePriority[cy.phase] ?? 0);
          const bScore =
            existing.submissions.length * 10 +
            (phasePriority[existing.phase] ?? 0);
          if (aScore > bScore) byLabel.set(cy.label, cy);
        }
        const mergedCycles = [...byLabel.values()].sort((a, b) => {
          const ak = a.periodStart ?? '';
          const bk = b.periodStart ?? '';
          return ak < bk ? -1 : 1;
        });
        out.push({ ...s, cycles: mergedCycles });
        continue;
      }
      out.push(s);
    }
    return out;
  }, [summaries]);

  // Group by coach, ordered alphabetically. Unassigned CEOs (coach is
  // null) are bucketed under a synthetic key and rendered last with an
  // "Unassigned" header — typing carries through via a string|null key.
  const grouped = useMemo(() => {
    const m = new Map<
      string,
      { coachKey: string | null; coachName: string; rows: RosterCeoSummary[] }
    >();
    for (const s of dedupedSummaries) {
      const key = s.coach?.id ?? '__unassigned__';
      const name = s.coach?.name ?? 'Unassigned';
      const slot = m.get(key);
      if (slot) slot.rows.push(s);
      else m.set(key, { coachKey: s.coach?.id ?? null, coachName: name, rows: [s] });
    }
    return [...m.values()].sort((a, b) => {
      // Pin Unassigned to the bottom.
      if (a.coachKey === null) return 1;
      if (b.coachKey === null) return -1;
      return a.coachName.localeCompare(b.coachName);
    });
  }, [dedupedSummaries]);

  if (summaries.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {/* Legend — pinned to the top of the Gantt so coaches see the key
          before they start interpreting the rows below. Two rows: cycle
          phase = colour of the bar itself, input type = colour of the
          dots stacked inside each bar. */}
      <div className="space-y-1.5 border-b border-border bg-muted/30 px-4 py-2.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            cycle phase
          </span>
          {(['gathering', 'ready', 'generated', 'sent', 'idle'] as const).map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{
                  background: PHASE_FILL[p],
                  border: `1px solid ${PHASE_STROKE[p]}`,
                }}
              />
              <span className="capitalize text-muted-foreground">{p}</span>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            input type
          </span>
          {INPUT_LEGEND.map(({ types, label }) => {
            const color = CONTENT_TYPE_DOT[types[0]] ?? 'var(--muted-foreground)';
            return (
              <span key={label} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 4,
                    background: color,
                    border: `1px solid ${color}`,
                  }}
                />
                <span className="text-muted-foreground">{label}</span>
              </span>
            );
          })}
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block"
              style={{
                width: 6,
                height: 6,
                borderRadius: 4,
                background: 'transparent',
                border: '1px solid var(--muted-foreground)',
              }}
            />
            <span className="text-muted-foreground">unconfirmed (hollow)</span>
          </span>
        </div>
      </div>

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
      {grouped.map(({ coachKey, coachName, rows }, gi) => (
        <div key={coachKey ?? '__unassigned__'}>
          {gi > 0 && <div className="h-px bg-border" />}
          <div
            className="grid items-center border-b border-border bg-muted/20 py-1.5"
            style={{ gridTemplateColumns: `${NAME_COL_WIDTH}px 1fr` }}
          >
            <div className="px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {coachName}
              <span className="ml-2 font-mono normal-case text-muted-foreground/70">
                · {rows.length} CEO{rows.length === 1 ? '' : 's'}
              </span>
            </div>
            <div />
          </div>
          {rows.map((s) => (
            <CeoRow
              key={s.ceo.id}
              summary={s}
              days={days}
              onCycleClick={(cycleId) => openCycle(s, cycleId)}
            />
          ))}
        </div>
      ))}

      {drawerTarget && (
        <WorkspaceDrawer
          summary={drawerTarget.summary}
          cycles={drawerTarget.summary.cycles}
          activeCycleId={drawerTarget.activeCycleId}
          onActiveCycleIdChange={(id) =>
            setDrawerTarget((t) => (t ? { ...t, activeCycleId: id } : t))
          }
          open={true}
          onOpenChange={(o) => {
            if (!o) setDrawerTarget(null);
          }}
        />
      )}
    </div>
  );
}

function CeoRow({
  summary,
  days,
  onCycleClick,
}: {
  summary: RosterCeoSummary;
  days: number;
  onCycleClick: (cycleId: string) => void;
}) {
  // For team rows: render stacked team avatars + the joint label
  // (matches the standard roster row). For solo rows: keep the single
  // CEO avatar + name. The cycles lane shows EVERY team member's
  // cycle stacked together so the Gantt is a true joint timeline,
  // not just the anchor member's history.
  const isTeam = summary.team !== null;
  const teamCycles = useMemo<RosterCycle[]>(() => {
    if (!summary.team) return summary.cycles;
    // We only get the anchor member's cycles in summary.cycles. The
    // other team members' cycles live on their own summaries — which
    // we deduped out at the page level. Resolve them via the parent's
    // memberCycles map (passed in via context below). When unavailable,
    // fall back to anchor's cycles alone — better than nothing.
    return summary.cycles;
  }, [summary]);
  const linkHref = isTeam
    ? `/ceos/${summary.ceo.id}` // anchor CEO; opening it surfaces the team workspace
    : `/ceos/${summary.ceo.id}`;
  const totalCycles = teamCycles.length;

  return (
    <div
      className="grid items-stretch border-b border-border last:border-b-0"
      style={{
        gridTemplateColumns: `${NAME_COL_WIDTH}px 1fr`,
        minHeight: ROW_HEIGHT,
      }}
    >
      <Link
        href={linkHref}
        className="flex items-center gap-2.5 border-r border-border px-3 transition-colors hover:bg-muted/30"
      >
        {isTeam && summary.team ? (
          <TeamAvatars
            members={summary.team.members}
            leadId={summary.ceo.id}
            size="sm"
            max={3}
          />
        ) : (
          <CeoAvatar
            name={summary.ceo.name}
            avatarUrl={summary.ceo.avatarUrl}
            size="sm"
            className="rounded-full"
          />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 truncate text-[13px] font-medium">
            <span className="truncate">
              {isTeam && summary.team
                ? joinNamesAmpersand(summary.team.members.map((m) => m.name))
                : summary.ceo.name}
            </span>
            {isTeam && (
              <span
                className="inline-flex shrink-0 items-center rounded px-1 py-px text-[9px] font-medium uppercase tracking-wider"
                style={{
                  background:
                    'color-mix(in oklab, oklch(58% 0.14 258), transparent 88%)',
                  color: 'oklch(58% 0.14 258)',
                }}
              >
                team
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {isTeam && summary.team
              ? summary.team.name
              : `${totalCycles} cycle${totalCycles === 1 ? '' : 's'}`}
          </div>
        </div>
      </Link>
      <ManagerLane
        cycles={teamCycles}
        days={days}
        onCycleClick={onCycleClick}
      />
    </div>
  );
}

/** "David & Dave" / "David, Dave & Megan" — same shape as the roster
 *  row helper. Kept local to avoid re-exporting from there and tying
 *  the modules together. */
function joinNamesAmpersand(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
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
  days,
  onCycleClick,
}: {
  cycles: RosterCycle[];
  days: number;
  onCycleClick: (cycleId: string) => void;
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
          <button
            key={cy.id}
            type="button"
            onClick={() => onCycleClick(cy.id)}
            title={`${cy.label} · ${cy.phase}`}
            className="absolute overflow-hidden rounded text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
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
          </button>
        );
      })}
    </div>
  );
}
