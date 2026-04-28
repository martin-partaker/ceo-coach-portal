'use client';

import { useState } from 'react';
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
import { RosterEditCeoDialog } from './roster-edit-ceo-dialog';
import { RosterReassignCeoDialog } from './roster-reassign-ceo-dialog';
import { RosterDeleteCeoDialog } from './roster-delete-ceo-dialog';

interface CoachOption {
  id: string;
  name: string;
  email: string;
}

interface Props {
  summary: RosterCeoSummary;
  coaches: CoachOption[];
  expanded: boolean;
  onToggle: () => void;
  /** Optional: render the expanded body when `expanded` is true. */
  renderExpanded?: (current: RosterCycle, all: RosterCycle[]) => React.ReactNode;
}

export function RosterV2Row({ summary, coaches, expanded, onToggle, renderExpanded }: Props) {
  const cycles = summary.cycles;
  const cur = cycles[cycles.length - 1] ?? null;

  const [editOpen, setEditOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const ceoCycleCount = cycles.length;

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
          <InlineTimeline cycles={cycles} />
        </div>

        {/* Readiness fraction */}
        <div className="flex justify-end">
          <FractionPill cycle={cur} />
        </div>

        {/* Next action */}
        <div className="flex justify-end">
          <NextAction cycle={cur} ceoId={summary.ceo.id} />
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
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setReassignOpen(true)}>
                <ArrowRightLeft className="mr-2 h-3.5 w-3.5" /> Reassign coach
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/ceos/${summary.ceo.id}`}>
                  <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Expanded body — Phase B injects this */}
      {expanded && cur && renderExpanded?.(cur, cycles)}

      <RosterEditCeoDialog
        ceo={{
          id: summary.ceo.id,
          name: summary.ceo.name,
          email: summary.ceo.email,
          tenXGoal: summary.ceo.tenXGoal,
        }}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <RosterReassignCeoDialog
        ceo={{ id: summary.ceo.id, name: summary.ceo.name, coachId: summary.ceo.coachId }}
        coaches={coaches}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
      />
      <RosterDeleteCeoDialog
        ceo={{ id: summary.ceo.id, name: summary.ceo.name, cycleCount: ceoCycleCount }}
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

function NextAction({ cycle, ceoId }: { cycle: RosterCycle | null; ceoId: string }) {
  if (!cycle) {
    return (
      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
        <Link href={`/ceos/${ceoId}`}>Open</Link>
      </Button>
    );
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
      <Button asChild size="sm" className="h-7 px-2 text-xs" style={{ background: 'oklch(58% 0.14 258)' }}>
        <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>Review →</Link>
      </Button>
    );
  }
  if (cycle.phase === 'ready') {
    return (
      <Button asChild size="sm" className="h-7 px-2 text-xs" style={{ background: 'oklch(58% 0.14 258)' }}>
        <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>Generate →</Link>
      </Button>
    );
  }
  // gathering — passive state, no urgent CTA
  return (
    <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
      <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>Open</Link>
    </Button>
  );
}
