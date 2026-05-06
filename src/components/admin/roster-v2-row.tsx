'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, MoreHorizontal, Pencil, ArrowRightLeft, Trash2, Loader2 } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { cn } from '@/lib/utils';
import type { RosterCeoSummary, RosterCycle, RosterReadiness } from '@/server/api/routers/roster';
import { deriveCycleLabel } from './roster-v2-shared';
import { RosterReassignCeoDialog } from './roster-reassign-ceo-dialog';
import { RosterDeleteCeoDialog } from './roster-delete-ceo-dialog';
import { CeoProfileDrawer } from './ceo-profile-drawer';

interface CoachOption {
  id: string;
  name: string;
  email: string;
}

interface RowIntent {
  /** Bumped each time the user clicks Review →; the expanded body uses
   *  this as a one-shot signal to auto-open the report reviewer. */
  reviewKey: number;
}

interface Props {
  summary: RosterCeoSummary;
  coaches: CoachOption[];
  expanded: boolean;
  onToggle: () => void;
  /** Optional: render the expanded body when `expanded` is true. The row
   *  controls which cycle is active so the inline Gantt above can highlight
   *  it; the expanded body should render the cycle identified by
   *  `activeCycleId` and call `setActiveCycleId` when the user picks a
   *  different tab. The 4th arg carries one-shot UI intents triggered by
   *  the row's NextAction buttons (e.g. auto-open the report reviewer). */
  renderExpanded?: (
    activeCycle: RosterCycle,
    all: RosterCycle[],
    setActiveCycleId: (id: string) => void,
    intent: RowIntent
  ) => React.ReactNode;
  /** Which surface this row is rendering on. `coach` hides the admin-only
   *  CEO actions (edit profile / reassign / delete) and the coach-side
   *  reassignment dropdown — those rely on `admin.*` mutations. Defaults
   *  to `'admin'` so existing call sites are unchanged. */
  surface?: 'admin' | 'coach';
}

export function RosterV2Row({
  summary,
  coaches,
  expanded,
  onToggle,
  renderExpanded,
  surface = 'admin',
}: Props) {
  const isAdmin = surface === 'admin';
  const cycles = summary.cycles;
  const cur = cycles[cycles.length - 1] ?? null;

  const [activeCycleId, setActiveCycleId] = useState<string | null>(cur?.id ?? null);

  // If the row's underlying cycles change (e.g. a new cycle was created
  // from the expanded panel), make sure the active id still resolves.
  useEffect(() => {
    if (!activeCycleId || !cycles.find((c) => c.id === activeCycleId)) {
      setActiveCycleId(cur?.id ?? null);
    }
  }, [cycles, activeCycleId, cur]);

  const activeCycle = cycles.find((c) => c.id === activeCycleId) ?? cur;

  const [editOpen, setEditOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reviewKey, setReviewKey] = useState(0);

  // Reset the review intent counter when the row collapses. Without this,
  // a "Review →" click leaves reviewKey ≥ 1 in row state, and the next
  // time the user expands the row by simply clicking on it the workspace
  // remounts, ReadinessCard's useEffect([reviewKey]) fires on mount, and
  // the report reviewer auto-opens — which is what just happened from
  // the user's perspective.
  useEffect(() => {
    if (!expanded) setReviewKey(0);
  }, [expanded]);

  // Open the inline workspace and (optionally) signal a one-shot intent
  // like "show me the report" that propagates to the expanded body.
  function expandWithIntent(targetCycleId: string, intent: 'review' | 'open') {
    setActiveCycleId(targetCycleId);
    if (!expanded) onToggle();
    if (intent === 'review') setReviewKey((k) => k + 1);
  }

  const ceoCycleCount = cycles.length;
  const ceoInputCount = cycles.reduce((n, c) => n + c.submissions.length, 0);

  // Detect ANY active generation for this CEO (across any of their
  // cycles, not just the currently-displayed one). Without this the
  // row's StatusLine only fires the "Generating" pill when the user
  // happens to be looking at the cycle being generated — leaving the
  // CEO row otherwise indistinguishable from idle while a job runs.
  const activeJobs = trpc.reports.listActiveJobs.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data && q.state.data.length > 0 ? 2000 : false),
    refetchIntervalInBackground: false,
  });
  const ceoCycleIds = new Set(cycles.map((c) => c.id));
  const liveJobForCeo = (activeJobs.data ?? []).find((j) =>
    ceoCycleIds.has(j.cycleId),
  );

  return (
    <div
      className={cn(
        'border-t border-border first:border-t-0',
        // Tint the entire row while a generation is running for this
        // CEO so the row is impossible to miss even if the user is
        // looking at a sibling cycle.
        liveJobForCeo &&
          'bg-[oklch(58%_0.14_258)/8] hover:bg-[oklch(58%_0.14_258)/12]',
      )}
    >
      {/* Always-visible row */}
      <div
        onClick={onToggle}
        className={cn(
          'grid cursor-pointer items-center gap-4 px-4 py-3 transition-colors',
          expanded && !liveJobForCeo && 'bg-muted/30',
          !expanded && !liveJobForCeo && 'hover:bg-muted/20',
        )}
        style={{ gridTemplateColumns: '20px 260px 1fr 140px 36px' }}
      >
        <span
          className="grid place-items-center text-muted-foreground transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </span>

        {/* CEO identity */}
        <div className="flex min-w-0 items-center gap-3">
          <CeoAvatar name={summary.ceo.name} avatarUrl={summary.ceo.avatarUrl} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 truncate text-sm font-medium">
              <span className="truncate">{summary.ceo.name}</span>
              {liveJobForCeo && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    background:
                      'color-mix(in oklab, oklch(58% 0.14 258), transparent 80%)',
                    color: 'oklch(58% 0.14 258)',
                  }}
                  title={`A v2 report is being generated for ${liveJobForCeo.cycleLabel}.`}
                >
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  Generating · {liveJobForCeo.cycleLabel}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {summary.ceo.email ?? '(no email)'}
            </div>
          </div>
        </div>

        {/* Status — phase + cycle + readiness summary, single line */}
        <div className="min-w-0">
          <StatusLine cycle={cur} />
        </div>

        {/* Next action */}
        <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
          <NextAction
            cycle={cur}
            onReview={() => cur && expandWithIntent(cur.id, 'review')}
            onOpenInline={() => cur && expandWithIntent(cur.id, 'open')}
          />
        </div>

        {/* Actions menu */}
        <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 opacity-60 hover:opacity-100"
                aria-label="CEO actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit profile
              </DropdownMenuItem>
              {/* Reassigning to another coach is inherently a cross-coach
                  action — admin only. Edit profile + Delete CEO now run
                  through the coach-scoped widening so both surfaces use
                  the same dialogs. */}
              {isAdmin && (
                <DropdownMenuItem onClick={() => setReassignOpen(true)}>
                  <ArrowRightLeft className="mr-2 h-3.5 w-3.5" /> Reassign coach
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete CEO
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Expanded body — Phase B injects this when there's a cycle to
          show; for a brand-new CEO (no cycles yet) we render a minimal
          empty-state so the row doesn't silently collapse to nothing. */}
      {expanded && activeCycle &&
        renderExpanded?.(activeCycle, cycles, setActiveCycleId, { reviewKey })}
      {expanded && !activeCycle && (
        <div className="border-t border-border bg-muted/20 px-12 py-6 text-[12px] text-muted-foreground">
          <p className="italic">
            No data for this coachee yet — no cycles, transcripts, or journals
            have been imported. Their first cycle will appear here automatically
            once a Tally submission or Zoom transcript lands, or you can create
            one manually from the CEO profile.
          </p>
        </div>
      )}

      {/* CEO profile + delete dialogs. The underlying admin.updateCeo /
          addCeoAlias / removeCeoAlias / deleteCeo procedures are now
          coach-scoped (Phase 4), so both surfaces mount these. The
          reassign-coach dialog stays admin-only because reassigning to
          another coach is inherently a cross-coach action. */}
      <CeoProfileDrawer
        ceo={{
          id: summary.ceo.id,
          name: summary.ceo.name,
          email: summary.ceo.email,
          avatarUrl: summary.ceo.avatarUrl,
          tenXGoal: summary.ceo.tenXGoal,
          coachId: summary.ceo.coachId,
          aliasEmails: summary.aliasEmails,
        }}
        open={editOpen}
        onOpenChange={setEditOpen}
        onReassign={
          isAdmin
            ? () => {
                setEditOpen(false);
                setReassignOpen(true);
              }
            : undefined
        }
        onDelete={() => {
          setEditOpen(false);
          setDeleteOpen(true);
        }}
      />
      {isAdmin && (
        <RosterReassignCeoDialog
          ceo={{ id: summary.ceo.id, name: summary.ceo.name, coachId: summary.ceo.coachId }}
          coaches={coaches}
          open={reassignOpen}
          onOpenChange={setReassignOpen}
        />
      )}
      <RosterDeleteCeoDialog
        ceo={{
          id: summary.ceo.id,
          name: summary.ceo.name,
          cycleCount: ceoCycleCount,
          inputCount: ceoInputCount,
        }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}

// Order mirrors the form: 10x banner → Inputs (transcript, weekly,
// KPIs when expected) → Synthesis (goals, reflection) → Actions.
const READINESS_LABELS: Array<{
  key: keyof RosterReadiness;
  label: string;
  /** When true the slot is dropped from the summary entirely if the
   *  cycle's readiness doesn't expect it (KPIs only kick in once a
   *  prior cycle has logged some). */
  conditional?: boolean;
}> = [
  { key: 'tenx', label: '10x goal' },
  { key: 'tx', label: 'transcript' },
  { key: 'weekly', label: 'weekly journals' },
  { key: 'kpi', label: 'KPIs', conditional: true },
  { key: 'goals', label: 'goals' },
  { key: 'reflect', label: 'reflection' },
  { key: 'actions', label: 'actions reviewed' },
];

function readinessSummary(r: RosterReadiness): {
  done: number;
  total: number;
  missing: string[];
} {
  const items = READINESS_LABELS.filter((i) => {
    // Conditional slots (KPIs) only count when the readiness object
    // marks them `expected`. Otherwise they're invisible — no fraction
    // contribution, no "missing" entry, no row in the readiness card.
    if (!i.conditional) return true;
    const slot = r[i.key];
    return 'expected' in slot && slot.expected;
  });
  const done = items.filter((i) => r[i.key].done).length;
  const missing = items.filter((i) => !r[i.key].done).map((i) => i.label);
  return { done, total: items.length, missing };
}

const PHASE_PALETTE: Record<
  RosterCycle['phase'],
  { dot: string; label: string; tone: 'green' | 'amber' | 'blue' | 'neutral' }
> = {
  ready: { dot: 'oklch(55% 0.12 152)', label: 'Ready', tone: 'green' },
  generated: { dot: 'oklch(58% 0.14 258)', label: 'Generated', tone: 'blue' },
  gathering: { dot: 'oklch(58% 0.13 64)', label: 'Gathering', tone: 'amber' },
  sent: { dot: 'oklch(55% 0.12 152)', label: 'Sent', tone: 'neutral' },
  idle: { dot: 'var(--muted-foreground)', label: 'Idle', tone: 'neutral' },
};

const TONE_FG: Record<'green' | 'amber' | 'blue' | 'neutral', string> = {
  green: 'oklch(55% 0.12 152)',
  amber: 'oklch(58% 0.13 64)',
  blue: 'oklch(58% 0.14 258)',
  neutral: 'var(--muted-foreground)',
};

const JOB_STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  extracting_facts: 'Reading inputs',
  matching_patterns: 'Comparing cycles',
  drafting_first: 'Drafting',
  critiquing: 'Reviewing',
  revising: 'Polishing',
  finalising: 'Finalising',
};

/**
 * Single-line status summary for a CEO row. Phase is the headline, then
 * one supporting fact tailored to the phase: missing-inputs hint when
 * gathering, "ready to send" when ready, "needs review" when generated,
 * a relative-age hint when sent. Replaces the old colored-dot timeline
 * + 7-color legend, which were noise the operator had to decode.
 */
function StatusLine({ cycle }: { cycle: RosterCycle | null }) {
  // Pull the global active-jobs query (already polled by the corner
  // background pill — sharing the cache costs nothing) so each row
  // can override its phase pill when a v2 generation is in flight.
  // This makes "we're working on a polished version right now" obvious
  // at the workspace level, not just inside the modal.
  const activeJobs = trpc.reports.listActiveJobs.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data && q.state.data.length > 0 ? 2000 : false),
    refetchIntervalInBackground: false,
  });
  const liveJob = cycle
    ? (activeJobs.data ?? []).find((j) => j.cycleId === cycle.id)
    : undefined;

  if (!cycle) {
    return <span className="text-[12px] italic text-muted-foreground">No cycle yet</span>;
  }

  // When a v2 generation is mid-flight for this cycle, swap the phase
  // pill for a "Generating polished" pill. The previous report (if
  // any) is still in the DB and viewable; this just signals that a
  // newer one is on the way.
  if (liveJob) {
    const stageLabel = JOB_STATUS_LABELS[liveJob.status as keyof typeof JOB_STATUS_LABELS] ?? liveJob.status;
    return (
      <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{
            background: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 88%)',
            color: 'oklch(58% 0.14 258)',
          }}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Generating polished
        </span>
        <span className="truncate text-[12px] text-muted-foreground">
          {stageLabel}
          {liveJob.revisionsApplied > 0 ? ` · revision ${liveJob.revisionsApplied}` : ''}
          {' · '}
          {deriveCycleLabel(cycle)}
        </span>
      </div>
    );
  }

  const palette = PHASE_PALETTE[cycle.phase];
  const cycleLabel = deriveCycleLabel(cycle);
  const { done, total, missing } = readinessSummary(cycle.readiness);

  let detail: React.ReactNode;
  if (cycle.phase === 'ready') {
    detail = (
      <>
        all {total} inputs ready · {cycleLabel}
      </>
    );
  } else if (cycle.phase === 'gathering') {
    const top = missing.slice(0, 2).join(', ');
    const more = missing.length > 2 ? ` +${missing.length - 2}` : '';
    detail = (
      <>
        {done}/{total} inputs · {cycleLabel} · still need {top}
        {more}
      </>
    );
  } else if (cycle.phase === 'generated') {
    const ageDays = cycle.generatedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(cycle.generatedAt).getTime()) / 86_400_000))
      : null;
    detail = (
      <>
        Email drafted{ageDays !== null && ` ${ageDays}d ago`} · awaiting your review · {cycleLabel}
      </>
    );
  } else if (cycle.phase === 'sent') {
    const ageDays = cycle.generatedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(cycle.generatedAt).getTime()) / 86_400_000))
      : null;
    detail = (
      <>
        Cycle closed{ageDays !== null && ` · sent ${ageDays}d ago`} · {cycleLabel}
      </>
    );
  } else {
    detail = (
      <>
        No activity yet · {cycleLabel}
      </>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
      <span
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{
          background: `color-mix(in oklab, ${TONE_FG[palette.tone]}, transparent 88%)`,
          color: TONE_FG[palette.tone],
        }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: palette.dot }}
        />
        {palette.label}
      </span>
      <span className="truncate text-[12px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function NextAction({
  cycle,
  onReview,
  onOpenInline,
}: {
  cycle: RosterCycle | null;
  onReview: () => void;
  onOpenInline: () => void;
}) {
  if (!cycle) return null;

  // Two states get a primary blue CTA — those are the actions the
  // operator should reach for first when scanning the page. Everything
  // else gets a low-key ghost button so the eye prioritises the work.
  if (cycle.phase === 'generated') {
    return (
      <Button
        size="sm"
        className="h-7 px-2 text-xs"
        style={{ background: 'oklch(58% 0.14 258)' }}
        onClick={onReview}
      >
        Review →
      </Button>
    );
  }
  if (cycle.phase === 'ready') {
    return (
      <Button
        size="sm"
        className="h-7 px-2 text-xs"
        style={{ background: 'oklch(58% 0.14 258)' }}
        onClick={onOpenInline}
      >
        Generate →
      </Button>
    );
  }
  if (cycle.phase === 'sent') {
    return (
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onOpenInline}>
        View
      </Button>
    );
  }
  // gathering / idle — open the workspace so the operator can fill in
  // what's missing.
  return (
    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onOpenInline}>
      Open
    </Button>
  );
}
