'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Loader2,
  Users,
  Search,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Trash2,
  ChevronRight,
} from 'lucide-react';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { cn } from '@/lib/utils';
import type { RosterCeoSummary } from '@/server/api/routers/roster';
import { CreateCoachDialog } from './create-coach-dialog';
import { RosterAddCeoDialog } from './roster-add-ceo-dialog';
import { RosterV2Row } from './roster-v2-row';
import { RosterEditCoachDialog } from './roster-edit-coach-dialog';
import { RosterDeleteCoachDialog } from './roster-delete-coach-dialog';
import { AddCeoDialog } from '@/components/ceos/add-ceo-dialog';

type Mode = 'roster' | 'manager';

/**
 * Which surface this page is rendering on.
 *  - `admin`: the cross-coach Roster v2 used at /admin/ceos. Shows the
 *    CreateCoachDialog, manager-mode toggle, per-coach grouping, and
 *    coach actions menu.
 *  - `coach`: the per-coach dashboard at /dashboard. Hides admin-only
 *    affordances and uses the coach-scoped AddCeoDialog (ceos.create)
 *    instead of the admin RosterAddCeoDialog (admin.createCeo).
 */
export type RosterSurface = 'admin' | 'coach';

interface Props {
  currentCoachId: string;
  /** Defaults to 'admin' so existing admin call sites are unchanged. */
  surface?: RosterSurface;
  /** Optional: render the per-row expanded body. Wired in Phase B. */
  renderExpanded?: React.ComponentProps<typeof RosterV2Row>['renderExpanded'];
  /** Optional: render the Manager mode content. Admin only. */
  renderManager?: (summaries: RosterCeoSummary[]) => React.ReactNode;
}

export function RosterV2Page({
  currentCoachId,
  surface = 'admin',
  renderExpanded,
  renderManager,
}: Props) {
  const isAdmin = surface === 'admin';
  // Coach surface always asks for coach scope — even when the caller is
  // a super admin viewing their own /dashboard, they should see only
  // their own CEOs (the cross-coach view lives on /admin/ceos).
  const { data, isLoading } = trpc.roster.cycleSummary.useQuery({
    scope: isAdmin ? 'all' : 'coach',
  });
  // Coach surface doesn't need the cross-coach list — it can't reassign.
  const { data: coachList } = trpc.admin.listCoaches.useQuery(undefined, {
    enabled: isAdmin,
  });

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('roster');
  // Coaches don't get manager mode — pin to roster regardless of state.
  const effectiveMode: Mode = isAdmin ? mode : 'roster';
  const [openCeoId, setOpenCeoId] = useState<string | null>(null);
  // Per-coach collapse state for the admin Roster v2. Default is "all
  // collapsed" so the page opens as a flat list of coaches and the
  // operator drills in deliberately. While there's a search query
  // every group force-expands so matches are visible.
  const [expandedCoachIds, setExpandedCoachIds] = useState<Set<string>>(new Set());
  const isSearching = query.trim().length > 0;
  function toggleCoachExpanded(id: string) {
    setExpandedCoachIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const summaries = useMemo<RosterCeoSummary[]>(() => data ?? [], [data]);

  const coachOptions = useMemo(() => {
    return (coachList ?? []).map((c) => ({ id: c.id, name: c.name, email: c.email }));
  }, [coachList]);

  // Filter by search across CEO name / email / alias / coach name
  const filteredSummaries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter((s) => {
      if (s.ceo.name.toLowerCase().includes(q)) return true;
      if ((s.ceo.email ?? '').toLowerCase().includes(q)) return true;
      if (s.aliasEmails.some((a) => a.toLowerCase().includes(q))) return true;
      if (s.coach?.name.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [summaries, query]);

  // Group by coach for the section headers. Start from `coachList` so a
  // coach with zero CEOs still gets a section — without this, just-created
  // coaches stay invisible until they have at least one CEO. Each group
  // then gets its filtered rows from the cycleSummary side. Unassigned
  // CEOs (coach === null) are bucketed separately and rendered after the
  // named coach groups. Search either matches the coach name (keep group,
  // even if empty) or row content.
  const { grouped, unassignedRows } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rowsByCoach = new Map<string, RosterCeoSummary[]>();
    const unassigned: RosterCeoSummary[] = [];
    for (const s of summaries) {
      if (!s.coach) {
        unassigned.push(s);
        continue;
      }
      const list = rowsByCoach.get(s.coach.id) ?? [];
      list.push(s);
      rowsByCoach.set(s.coach.id, list);
    }
    const allCoaches = (coachList ?? []).map((c) => ({
      // Shape this to match RosterCeoSummary['coach'] so the existing
      // CoachGroup component can render either a populated or empty
      // section without branching.
      id: c.id,
      name: c.name,
      email: c.email,
      zoomUserEmail: c.zoomUserEmail,
      isSuperAdmin: c.isSuperAdmin,
      neonAuthUserId: c.neonAuthUserId,
    }));
    // Some cycleSummary rows may reference coaches that aren't in
    // coachList (defensive — admin.listCoaches has its own filter). Add
    // any leftover coaches from summaries so we don't drop their rows.
    for (const s of summaries) {
      if (s.coach && !allCoaches.some((c) => c.id === s.coach!.id)) {
        allCoaches.push(s.coach);
      }
    }
    const groups = allCoaches.map((coach) => {
      const rows = rowsByCoach.get(coach.id) ?? [];
      // Apply the search filter: by row OR coach name. If the coach name
      // matches, keep all their rows so the user sees the full section.
      const coachMatches = q === '' || coach.name.toLowerCase().includes(q);
      const filteredRows = q === ''
        ? rows
        : rows.filter((s) => {
            if (coachMatches) return true;
            if (s.ceo.name.toLowerCase().includes(q)) return true;
            if ((s.ceo.email ?? '').toLowerCase().includes(q)) return true;
            if (s.aliasEmails.some((a) => a.toLowerCase().includes(q))) return true;
            return false;
          });
      return { coach, rows: filteredRows };
    });
    const filteredGroups = groups
      .filter(({ coach, rows }) => {
        if (q === '') return true;
        if (coach.name.toLowerCase().includes(q)) return true;
        return rows.length > 0;
      })
      .sort((a, b) => a.coach.name.localeCompare(b.coach.name));

    // Same search behavior for the unassigned bucket — show it whenever
    // we have anything to display (or when "unassigned" itself matches).
    const unassignedMatches = q === '' || 'unassigned'.includes(q);
    const filteredUnassigned = q === ''
      ? unassigned
      : unassigned.filter((s) => {
          if (unassignedMatches) return true;
          if (s.ceo.name.toLowerCase().includes(q)) return true;
          if ((s.ceo.email ?? '').toLowerCase().includes(q)) return true;
          if (s.aliasEmails.some((a) => a.toLowerCase().includes(q))) return true;
          return false;
        });

    return { grouped: filteredGroups, unassignedRows: filteredUnassigned };
  }, [coachList, summaries, query]);

  // Subtitle counts by phase. CEOs without any cycles get their own
  // bucket so the totals add up (a CEO with no cycle isn't gathering,
  // ready, generated, sent, or idle — there's literally nothing to be
  // in any of those states).
  const counts = useMemo(() => {
    let ready = 0,
      generated = 0,
      gathering = 0,
      sent = 0,
      idle = 0,
      noCycle = 0;
    for (const s of summaries) {
      const last = s.cycles[s.cycles.length - 1];
      if (!last) {
        noCycle += 1;
        continue;
      }
      if (last.phase === 'ready') ready++;
      else if (last.phase === 'generated') generated++;
      else if (last.phase === 'gathering') gathering++;
      else if (last.phase === 'sent') sent++;
      else idle++;
    }
    return { ready, generated, gathering, sent, idle, noCycle };
  }, [summaries]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const headerTitle = 'Dashboard';
  // Show only buckets that have at least one CEO so the math always adds
  // up to the headline total. The order here is roughly action priority:
  // ready ⟶ generated are things the operator should look at; gathering
  // is the default working state; idle / sent / no-cycle are stable or
  // empty states.
  const bucketParts: string[] = [];
  if (counts.ready) bucketParts.push(`${counts.ready} ready`);
  if (counts.generated) bucketParts.push(`${counts.generated} generated`);
  if (counts.gathering) bucketParts.push(`${counts.gathering} gathering`);
  if (counts.sent) bucketParts.push(`${counts.sent} sent`);
  if (counts.idle) bucketParts.push(`${counts.idle} idle`);
  if (counts.noCycle) bucketParts.push(`${counts.noCycle} no cycle`);
  const totalLabel = `${summaries.length} CEO${summaries.length === 1 ? '' : 's'}${
    isAdmin ? '' : ' on your roster'
  }`;
  const headerSubtitle =
    bucketParts.length > 0 ? `${totalLabel} · ${bucketParts.join(' · ')}` : totalLabel;
  const searchPlaceholder = isAdmin
    ? 'Search name / email / coach…'
    : 'Search CEO name or email…';

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">{headerTitle}</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{headerSubtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-64 pl-8"
            />
          </div>
          {isAdmin && <ModeToggle mode={mode} onChange={setMode} />}
          {isAdmin && <CreateCoachDialog />}
          {isAdmin ? (
            <RosterAddCeoDialog coaches={coachOptions} triggerVariant="default" />
          ) : (
            <AddCeoDialog />
          )}
        </div>
      </div>

      {/* Body */}
      {summaries.length === 0 && (!isAdmin || (coachList ?? []).length === 0) ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          {isAdmin
            ? 'No CEOs yet. Add a coach and a CEO to get started.'
            : 'No CEOs on your roster yet. Add your first coachee to get started.'}
        </div>
      ) : effectiveMode === 'manager' ? (
        <>
          {renderManager ? (
            renderManager(filteredSummaries)
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
              Manager mode — Gantt view coming in Phase C.
            </div>
          )}
        </>
      ) : isAdmin ? (
        <div className="space-y-5">
          {grouped.map(({ coach, rows }) => (
            <CoachGroup
              key={coach.id}
              coach={coach}
              rows={rows}
              coachOptions={coachOptions}
              openCeoId={openCeoId}
              onToggle={(id) => setOpenCeoId(openCeoId === id ? null : id)}
              renderExpanded={renderExpanded}
              currentCoachId={currentCoachId}
              expanded={isSearching || expandedCoachIds.has(coach.id)}
              onToggleExpand={() => toggleCoachExpanded(coach.id)}
            />
          ))}
          {unassignedRows.length > 0 && (
            <UnassignedGroup
              rows={unassignedRows}
              coachOptions={coachOptions}
              openCeoId={openCeoId}
              onToggle={(id) => setOpenCeoId(openCeoId === id ? null : id)}
              renderExpanded={renderExpanded}
              expanded={isSearching || expandedCoachIds.has('__unassigned__')}
              onToggleExpand={() => toggleCoachExpanded('__unassigned__')}
            />
          )}
        </div>
      ) : (
        // Coach surface: skip the per-coach grouping (there's only one
        // coach — themselves) and render a flat list of CEO rows.
        <div>
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            {filteredSummaries.map((r) => (
              <RosterV2Row
                key={r.ceo.id}
                summary={r}
                coaches={coachOptions}
                expanded={openCeoId === r.ceo.id}
                onToggle={() => setOpenCeoId(openCeoId === r.ceo.id ? null : r.ceo.id)}
                renderExpanded={renderExpanded}
                surface="coach"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  // Mode internal id stays 'roster' to avoid ripping through every
  // reference; the user-facing label is "List" since the page is now
  // titled "Dashboard" (calling the toggle "Roster | Manager" inside
  // a "Dashboard" page would read weird).
  const opts: Array<{ id: Mode; label: string }> = [
    { id: 'roster', label: 'List' },
    { id: 'manager', label: 'Manager' },
  ];
  return (
    <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
      {opts.map((o) => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={cn(
              'rounded px-2.5 py-1 text-xs transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            style={{ fontWeight: active ? 500 : 400 }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function CoachGroup({
  coach,
  rows,
  coachOptions,
  openCeoId,
  onToggle,
  renderExpanded,
  currentCoachId,
  expanded,
  onToggleExpand,
}: {
  coach: NonNullable<RosterCeoSummary['coach']>;
  rows: RosterCeoSummary[];
  coachOptions: Array<{ id: string; name: string; email: string }>;
  openCeoId: string | null;
  onToggle: (id: string) => void;
  renderExpanded?: React.ComponentProps<typeof RosterV2Row>['renderExpanded'];
  currentCoachId: string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const isSelf = currentCoachId === coach.id;
  // Compact summary across this coach's CEOs so the collapsed header
  // still tells the operator something useful at a glance: how many
  // CEOs they have and how many cycles need attention right now.
  const phaseCounts = useMemo(() => {
    let ready = 0;
    let generated = 0;
    let gathering = 0;
    let sent = 0;
    let idle = 0;
    let noCycle = 0;
    for (const r of rows) {
      const last = r.cycles[r.cycles.length - 1];
      if (!last) {
        noCycle++;
        continue;
      }
      if (last.phase === 'ready') ready++;
      else if (last.phase === 'generated') generated++;
      else if (last.phase === 'gathering') gathering++;
      else if (last.phase === 'sent') sent++;
      else idle++;
    }
    return { ready, generated, gathering, sent, idle, noCycle };
  }, [rows]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <CoachHeader
        coach={coach}
        ceoCount={rows.length}
        phaseCounts={phaseCounts}
        isSelf={isSelf}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
      />
      {expanded && (
        <div className="border-t border-border">
          {rows.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-4 text-[12px] text-muted-foreground">
              <span className="italic">No CEOs assigned to this coach yet.</span>
              <span className="flex-1" />
              <RosterAddCeoDialog
                coaches={coachOptions}
                defaultCoachId={coach.id}
                triggerVariant="ghost"
                triggerSize="sm"
                triggerLabel="Add CEO"
              />
            </div>
          ) : (
            rows.map((r) => (
              <RosterV2Row
                key={r.ceo.id}
                summary={r}
                coaches={coachOptions}
                expanded={openCeoId === r.ceo.id}
                onToggle={() => onToggle(r.ceo.id)}
                renderExpanded={renderExpanded}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Clickable coach-row header. Shows: chevron, avatar, name + email,
 * compact stats, badges (admin / you), a labelled Edit button (clear
 * affordance — the lone "⋯" was confusing operators), and a smaller
 * dropdown for less-common actions.
 */
function CoachHeader({
  coach,
  ceoCount,
  phaseCounts,
  isSelf,
  expanded,
  onToggleExpand,
}: {
  coach: NonNullable<RosterCeoSummary['coach']>;
  ceoCount: number;
  phaseCounts: {
    ready: number;
    generated: number;
    gathering: number;
    sent: number;
    idle: number;
    noCycle: number;
  };
  isSelf: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const summaryParts: string[] = [];
  if (phaseCounts.ready) summaryParts.push(`${phaseCounts.ready} ready`);
  if (phaseCounts.generated) summaryParts.push(`${phaseCounts.generated} generated`);
  if (phaseCounts.gathering) summaryParts.push(`${phaseCounts.gathering} gathering`);
  if (phaseCounts.idle || phaseCounts.noCycle) {
    const idle = phaseCounts.idle + phaseCounts.noCycle;
    summaryParts.push(`${idle} idle`);
  }
  const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : null;

  return (
    <div
      onClick={onToggleExpand}
      className={cn(
        'grid cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors',
        // Coach headers get a distinct neutral tint so a coach row never
        // looks like just another CEO row in the list. Uses oklch
        // mixing to stay theme-aware in both light and dark modes.
        expanded ? 'bg-muted/55' : 'bg-muted/30 hover:bg-muted/45'
      )}
      style={{
        gridTemplateColumns: '20px auto 1fr auto',
        borderLeft: '3px solid oklch(58% 0.14 258)',
      }}
    >
      <span
        className="grid place-items-center text-muted-foreground transition-transform"
        style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}
        aria-hidden
      >
        <ChevronRight className="h-4 w-4" />
      </span>

      <CeoAvatar name={coach.name} avatarUrl={null} size="md" />

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {/* Explicit "Coach" badge — operators were reading the name
              alone and not realising it was a section header. */}
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              background: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 86%)',
              color: 'oklch(58% 0.14 258)',
            }}
          >
            Coach
          </span>
          <span className="truncate text-[15px] font-semibold leading-tight">
            {coach.name}
          </span>
          <span className="truncate font-mono text-[11.5px] text-muted-foreground">
            {coach.email}
          </span>
          {coach.isSuperAdmin && (
            <span className="inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-purple-700 dark:text-purple-400">
              <ShieldCheck className="h-2.5 w-2.5" /> admin
            </span>
          )}
          {isSelf && (
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/80">
              you
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
          {ceoCount === 0
            ? 'No CEOs yet'
            : `${ceoCount} CEO${ceoCount === 1 ? '' : 's'}${summary ? ` · ${summary}` : ''}`}
        </div>
      </div>

      <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
        <CoachActionsMenu coach={coach} ceoCount={ceoCount} isSelf={isSelf} />
      </div>
    </div>
  );
}

/**
 * Section for CEOs that exist on the roster but have no coach assigned
 * yet. Pinned to the bottom of the admin Roster v2 page. The header
 * mirrors the CoachGroup styling but doesn't try to look like a coach
 * (no "you" badge, no edit/delete affordances) — it's a holding bucket
 * the user moves rows out of via the row's "Reassign coach" menu item.
 */
function UnassignedGroup({
  rows,
  coachOptions,
  openCeoId,
  onToggle,
  renderExpanded,
  expanded,
  onToggleExpand,
}: {
  rows: RosterCeoSummary[];
  coachOptions: Array<{ id: string; name: string; email: string }>;
  openCeoId: string | null;
  onToggle: (id: string) => void;
  renderExpanded?: React.ComponentProps<typeof RosterV2Row>['renderExpanded'];
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-dashed border-border bg-background">
      <div
        onClick={onToggleExpand}
        className={cn(
          'grid cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors',
          expanded ? 'bg-amber-500/10' : 'bg-amber-500/5 hover:bg-amber-500/10'
        )}
        style={{
          gridTemplateColumns: '20px auto 1fr auto',
          borderLeft: '3px solid oklch(58% 0.13 64)',
        }}
      >
        <span
          className="grid place-items-center text-muted-foreground transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}
          aria-hidden
        >
          <ChevronRight className="h-4 w-4" />
        </span>
        <CeoAvatar name="??" avatarUrl={null} size="md" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                background: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 86%)',
                color: 'oklch(58% 0.13 64)',
              }}
            >
              Unassigned
            </span>
            <span className="text-[15px] font-semibold leading-tight">
              No coach yet
            </span>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
              needs a coach
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {rows.length} CEO{rows.length === 1 ? '' : 's'} waiting to be assigned
          </div>
        </div>
        <span />
      </div>
      {expanded && (
        <div className="border-t border-border">
          {rows.map((r) => (
            <RosterV2Row
              key={r.ceo.id}
              summary={r}
              coaches={coachOptions}
              expanded={openCeoId === r.ceo.id}
              onToggle={() => onToggle(r.ceo.id)}
              renderExpanded={renderExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CoachActionsMenu({
  coach,
  ceoCount,
  isSelf,
}: {
  coach: NonNullable<RosterCeoSummary['coach']>;
  ceoCount: number;
  isSelf: boolean;
}) {
  const utils = trpc.useUtils();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const toggleAdmin = trpc.admin.toggleAdmin.useMutation({
    onSuccess: () => {
      utils.admin.listCoaches.invalidate();
      utils.admin.listAllCeos.invalidate();
      utils.roster.cycleSummary.invalidate();
    },
  });

  return (
    <>
      {/* Visible primary action — operators were missing the lone "⋯"
          when scanning; an explicit "Edit" button clears that up. */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => setEditOpen(true)}
      >
        <Pencil className="mr-1.5 h-3 w-3" />
        Edit
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 opacity-60 hover:opacity-100"
            aria-label={`More actions for ${coach.name}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={isSelf || toggleAdmin.isPending}
            onClick={() => toggleAdmin.mutate({ coachId: coach.id })}
          >
            <ShieldCheck className="mr-2 h-3.5 w-3.5" />
            {coach.isSuperAdmin ? 'Revoke super-admin' : 'Make super-admin'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setDeleteOpen(true)}
            disabled={isSelf}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete coach
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RosterEditCoachDialog
        coach={{
          id: coach.id,
          name: coach.name,
          email: coach.email,
          zoomUserEmail: coach.zoomUserEmail,
        }}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <RosterDeleteCoachDialog
        coach={{ id: coach.id, name: coach.name }}
        ceoCount={ceoCount}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

