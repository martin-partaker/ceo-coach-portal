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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RosterCeoSummary } from '@/server/api/routers/roster';
import { CreateCoachDialog } from './create-coach-dialog';
import { RosterAddCeoDialog } from './roster-add-ceo-dialog';
import { RosterV2Row } from './roster-v2-row';
import { RosterEditCoachDialog } from './roster-edit-coach-dialog';
import { RosterDeleteCoachDialog } from './roster-delete-coach-dialog';
import { AddCeoDialog } from '@/components/ceos/add-ceo-dialog';
import { CONTENT_TYPE_DOT, CONTENT_TYPE_LABEL } from './roster-v2-shared';

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
      if (s.coach.name.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [summaries, query]);

  // Group by coach for the section headers
  const grouped = useMemo(() => {
    const map = new Map<string, { coach: RosterCeoSummary['coach']; rows: RosterCeoSummary[] }>();
    for (const s of filteredSummaries) {
      const existing = map.get(s.coach.id);
      if (existing) existing.rows.push(s);
      else map.set(s.coach.id, { coach: s.coach, rows: [s] });
    }
    return [...map.values()].sort((a, b) => a.coach.name.localeCompare(b.coach.name));
  }, [filteredSummaries]);

  // Subtitle counts by phase
  const counts = useMemo(() => {
    let ready = 0,
      generated = 0,
      gathering = 0,
      sent = 0,
      idle = 0;
    for (const s of summaries) {
      const last = s.cycles[s.cycles.length - 1];
      if (!last) continue;
      if (last.phase === 'ready') ready++;
      else if (last.phase === 'generated') generated++;
      else if (last.phase === 'gathering') gathering++;
      else if (last.phase === 'sent') sent++;
      else idle++;
    }
    return { ready, generated, gathering, sent, idle };
  }, [summaries]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const headerTitle = isAdmin ? 'Roster' : 'Dashboard';
  const headerSubtitle = isAdmin
    ? `${summaries.length} CEO${summaries.length === 1 ? '' : 's'} · ${counts.ready} ready · ${counts.generated} generated · ${counts.gathering} gathering`
    : `${summaries.length} CEO${summaries.length === 1 ? '' : 's'} on your roster · ${counts.ready} ready · ${counts.generated} generated · ${counts.gathering} gathering`;
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
      {summaries.length === 0 ? (
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
            />
          ))}
        </div>
      ) : (
        // Coach surface: skip the per-coach grouping (there's only one
        // coach — themselves) and render a flat list of CEO rows. The
        // Legend lives just above the list so the dot colors used in
        // the timeline strip aren't a mystery.
        <div>
          <div className="mb-1 flex items-center justify-end gap-3 px-1 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Legend />
          </div>
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
  const opts: Array<{ id: Mode; label: string }> = [
    { id: 'roster', label: 'Roster' },
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
}: {
  coach: RosterCeoSummary['coach'];
  rows: RosterCeoSummary[];
  coachOptions: Array<{ id: string; name: string; email: string }>;
  openCeoId: string | null;
  onToggle: (id: string) => void;
  renderExpanded?: React.ComponentProps<typeof RosterV2Row>['renderExpanded'];
  currentCoachId: string;
}) {
  const isSelf = currentCoachId === coach.id;
  return (
    <div>
      {/* Coach header */}
      <div className="mb-1 flex items-center gap-2 px-1 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        <span className="font-mono text-foreground/80">{coach.name}</span>
        <span>·</span>
        <span className="font-mono">
          {rows.length} CEO{rows.length === 1 ? '' : 's'}
        </span>
        {!coach.neonAuthUserId && (
          <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[9px] normal-case text-muted-foreground/80">
            auto-created
          </span>
        )}
        {coach.isSuperAdmin && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[9px] normal-case text-purple-700 dark:text-purple-400">
            <ShieldCheck className="h-2.5 w-2.5" /> admin
          </span>
        )}
        <span className="flex-1" />
        <Legend />
        {isSelf && (
          <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[9px] normal-case text-muted-foreground/80">
            you
          </span>
        )}
        <CoachActionsMenu coach={coach} ceoCount={rows.length} isSelf={isSelf} />
      </div>

      {/* Rows */}
      <div className="overflow-hidden rounded-lg border border-border bg-background">
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
    </div>
  );
}

function CoachActionsMenu({
  coach,
  ceoCount,
  isSelf,
}: {
  coach: RosterCeoSummary['coach'];
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="ml-1 h-6 w-6 p-0 opacity-60 hover:opacity-100"
            aria-label={`Actions for ${coach.name}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <Pencil className="mr-2 h-3.5 w-3.5" /> Edit coach
          </DropdownMenuItem>
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

function Legend() {
  const items: Array<{ key: string; label: string }> = [
    { key: 'weekly_journal', label: CONTENT_TYPE_LABEL.weekly_journal },
    { key: 'monthly_journal', label: CONTENT_TYPE_LABEL.monthly_journal },
    { key: 'transcript', label: CONTENT_TYPE_LABEL.transcript },
    { key: 'goal_worksheet', label: '10x' },
  ];
  return (
    <span className="hidden items-center gap-3 md:inline-flex">
      {items.map((i) => (
        <span key={i.key} className="inline-flex items-center gap-1 normal-case">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: CONTENT_TYPE_DOT[i.key] }}
          />
          <span className="font-mono text-[10px] text-muted-foreground/80">{i.label}</span>
        </span>
      ))}
    </span>
  );
}
