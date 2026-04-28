'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, MoreHorizontal, Pencil, ArrowRightLeft, ExternalLink, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { cn } from '@/lib/utils';
import type { RosterCeoSummary, RosterCycle, RosterReadiness } from '@/server/api/routers/roster';
import { InlineTimeline } from './roster-v2-timeline';
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

  // Open the inline workspace and (optionally) signal a one-shot intent
  // like "show me the report" that propagates to the expanded body.
  function expandWithIntent(targetCycleId: string, intent: 'review' | 'open') {
    setActiveCycleId(targetCycleId);
    if (!expanded) onToggle();
    if (intent === 'review') setReviewKey((k) => k + 1);
  }

  const ceoCycleCount = cycles.length;
  const ceoInputCount = cycles.reduce((n, c) => n + c.submissions.length, 0);

  return (
    <div className="border-t border-border first:border-t-0">
      {/* Always-visible row */}
      <div
        onClick={onToggle}
        className={cn(
          'grid cursor-pointer items-center gap-4 px-4 py-3 transition-colors',
          expanded ? 'bg-muted/30' : 'hover:bg-muted/20'
        )}
        style={{ gridTemplateColumns: '20px 220px 1fr 130px 140px 36px' }}
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
            <div className="truncate text-sm font-medium">{summary.ceo.name}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {summary.ceo.email ?? '(no email)'}
            </div>
          </div>
        </div>

        {/* Inline timeline */}
        <div className="min-w-0">
          <InlineTimeline
            cycles={cycles}
            highlightCycleId={expanded ? activeCycleId : null}
          />
        </div>

        {/* Readiness fraction */}
        <div className="flex justify-end">
          <FractionPill cycle={cur} />
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
              <DropdownMenuItem asChild>
                <Link href={`/ceos/${summary.ceo.id}`}>
                  <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open full page
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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

      {/* Expanded body — Phase B injects this */}
      {expanded && activeCycle && renderExpanded?.(activeCycle, cycles, setActiveCycleId, { reviewKey })}

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

function readinessFraction(r: RosterReadiness): { done: number; total: number } {
  const items = [r.tenx, r.goals, r.reflect, r.weekly, r.tx, r.actions];
  return {
    done: items.filter((i) => i.done).length,
    total: items.length,
  };
}

function FractionPill({ cycle }: { cycle: RosterCycle | null }) {
  if (!cycle) {
    return <span className="text-[11px] text-muted-foreground">— no cycle —</span>;
  }
  const { done, total } = readinessFraction(cycle.readiness);
  const tone = done === total ? 'green' : done === 0 ? 'neutral' : 'amber';
  const palette: Record<string, { bg: string; fg: string; bd: string }> = {
    green: {
      bg: 'color-mix(in oklab, oklch(55% 0.12 152), transparent 88%)',
      fg: 'oklch(55% 0.12 152)',
      bd: 'color-mix(in oklab, oklch(55% 0.12 152), transparent 60%)',
    },
    amber: {
      bg: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 90%)',
      fg: 'oklch(58% 0.13 64)',
      bd: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 60%)',
    },
    neutral: { bg: 'var(--muted)', fg: 'var(--muted-foreground)', bd: 'var(--border)' },
  };
  const t = palette[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px]"
      style={{ background: t.bg, color: t.fg, border: `1px solid ${t.bd}` }}
    >
      <span style={{ fontWeight: 500 }}>
        {done}/{total}
      </span>
      <span style={{ opacity: 0.7 }}>inputs</span>
      <span style={{ opacity: 0.5 }}>·</span>
      <span style={{ opacity: 0.7 }}>{cycle.label.split(' ')[0]}</span>
    </span>
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
  if (!cycle) {
    return null;
  }
  if (cycle.phase === 'sent') {
    return <span className="font-mono text-[11px] text-muted-foreground">cycle closed</span>;
  }
  if (cycle.phase === 'idle') {
    return (
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
        Nudge
      </Button>
    );
  }
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
  // gathering — passive state, no urgent CTA. The chevron on the left
  // already expands the row inline, so we don't render a redundant button.
  return null;
}
