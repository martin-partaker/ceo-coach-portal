'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CreateCoachDialog } from './create-coach-dialog';
import { RosterAddCeoDialog } from './roster-add-ceo-dialog';
import { RosterCeoRow, type RosterCeoRowData } from './roster-ceo-row';
import { RosterEditCoachDialog } from './roster-edit-coach-dialog';
import { RosterDeleteCoachDialog } from './roster-delete-coach-dialog';

interface CoachOption {
  id: string;
  name: string;
  email: string;
  zoomUserEmail: string | null;
  isSuperAdmin: boolean;
  neonAuthUserId: string | null;
}

export function RosterPage({ currentCoachId }: { currentCoachId: string }) {
  const { data: rows, isLoading } = trpc.admin.listAllCeos.useQuery();
  const { data: coachList } = trpc.admin.listCoaches.useQuery();

  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const coaches: CoachOption[] = useMemo(() => {
    return (coachList ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      zoomUserEmail: c.zoomUserEmail,
      isSuperAdmin: c.isSuperAdmin,
      neonAuthUserId: c.neonAuthUserId,
    }));
  }, [coachList]);

  // Group CEO rows by coach. Add empty groups for coaches with 0 CEOs.
  const grouped = useMemo(() => {
    const byCoach = new Map<
      string,
      { coach: CoachOption; ceos: RosterCeoRowData[] }
    >();
    for (const c of coaches) {
      byCoach.set(c.id, { coach: c, ceos: [] });
    }
    for (const r of rows ?? []) {
      const slot = byCoach.get(r.coach.id);
      if (!slot) continue;
      slot.ceos.push({
        id: r.ceo.id,
        name: r.ceo.name,
        email: r.ceo.email,
        avatarUrl: r.ceo.avatarUrl ?? null,
        tenXGoal: r.ceo.tenXGoal,
        coachId: r.coach.id,
        cycleCount: r.cycleCount,
        hasReport: r.hasReport,
        latestCycleLabel: r.latestCycle?.label ?? null,
        aliasEmails: r.aliasEmails,
      });
    }
    return [...byCoach.values()].sort((a, b) =>
      a.coach.name.localeCompare(b.coach.name)
    );
  }, [coaches, rows]);

  // Search filter — match CEO name, email, alias, or coach name.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return grouped;
    return grouped
      .map(({ coach, ceos }) => {
        const coachMatches = coach.name.toLowerCase().includes(q);
        const matchedCeos = ceos.filter((c) => {
          if (coachMatches) return true;
          if (c.name.toLowerCase().includes(q)) return true;
          if ((c.email ?? '').toLowerCase().includes(q)) return true;
          if (c.aliasEmails.some((a) => a.toLowerCase().includes(q))) return true;
          return false;
        });
        return { coach, ceos: matchedCeos, coachMatches };
      })
      .filter(({ ceos, coachMatches }) => coachMatches || ceos.length > 0);
  }, [grouped, query]);

  const totalCeos = useMemo(
    () => grouped.reduce((sum, g) => sum + g.ceos.length, 0),
    [grouped]
  );

  function toggleCollapse(coachId: string) {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(coachId)) next.delete(coachId);
      else next.add(coachId);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header / actions */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">Roster</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalCeos} CEO{totalCeos === 1 ? '' : 's'} across {coaches.length} coach
            {coaches.length === 1 ? '' : 'es'}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name / email / coach…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-64 pl-8"
            />
          </div>
          <CreateCoachDialog />
          <RosterAddCeoDialog
            coaches={coaches.map((c) => ({ id: c.id, name: c.name, email: c.email }))}
            triggerVariant="default"
          />
        </div>
      </div>

      {/* Empty states */}
      {coaches.length === 0 && (
        <Card className="p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No coaches in the system yet. Add one to get started.
          </p>
        </Card>
      )}

      {coaches.length > 0 && filtered.length === 0 && (
        <Card className="p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No matches for &ldquo;{query}&rdquo;.
          </p>
        </Card>
      )}

      {/* Coach sections */}
      <div className="space-y-3">
        {filtered.map(({ coach, ceos }) => (
          <CoachSection
            key={coach.id}
            coach={coach}
            ceos={ceos}
            coachOptions={coaches.map((c) => ({
              id: c.id,
              name: c.name,
              email: c.email,
            }))}
            collapsed={collapsed.has(coach.id)}
            onToggleCollapse={() => toggleCollapse(coach.id)}
            highlight={query.trim()}
            currentCoachId={currentCoachId}
          />
        ))}
      </div>
    </div>
  );
}

function CoachSection({
  coach,
  ceos,
  coachOptions,
  collapsed,
  onToggleCollapse,
  highlight,
  currentCoachId,
}: {
  coach: CoachOption;
  ceos: RosterCeoRowData[];
  coachOptions: { id: string; name: string; email: string }[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  highlight: string;
  currentCoachId: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isAutoCreated = !coach.neonAuthUserId;
  const isSelf = coach.id === currentCoachId;

  return (
    <Card className="overflow-hidden">
      {/* Section header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {coach.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium">{coach.name}</p>
              {coach.isSuperAdmin && (
                <Badge className="border-purple-500/20 bg-purple-500/10 text-[10px] text-purple-600 dark:text-purple-400">
                  Admin
                </Badge>
              )}
              {isAutoCreated && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  Auto-created · pending signup
                </Badge>
              )}
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {coach.email}
              {coach.zoomUserEmail && coach.zoomUserEmail !== coach.email && (
                <span className="ml-2 text-muted-foreground/70">
                  zoom: {coach.zoomUserEmail}
                </span>
              )}
            </p>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {ceos.length} CEO{ceos.length === 1 ? '' : 's'}
          </span>
          <RosterAddCeoDialog
            coaches={coachOptions}
            defaultCoachId={coach.id}
            triggerVariant="ghost"
            triggerSize="sm"
            triggerLabel="Add CEO"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Coach actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit coach
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/admin/coaches/${coach.id}`}>
                  <UserCog className="mr-2 h-3.5 w-3.5" /> Open detail
                  {coach.isSuperAdmin && <ShieldCheck className="ml-2 h-3 w-3" />}
                </Link>
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
        </div>
      </div>

      {/* CEOs */}
      {!collapsed && (
        <>
          <div className="border-t border-border">
            {ceos.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-6 py-6 text-xs text-muted-foreground">
                No CEOs yet ·{' '}
                <RosterAddCeoDialog
                  coaches={coachOptions}
                  defaultCoachId={coach.id}
                  triggerVariant="outline"
                  triggerSize="sm"
                  triggerLabel="Add the first one"
                />
              </div>
            ) : (
              <div className="divide-y divide-border">
                {ceos.map((ceo) => (
                  <RosterCeoRow
                    key={ceo.id}
                    ceo={ceo}
                    coaches={coachOptions}
                    highlight={highlight}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

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
        ceoCount={ceos.length}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </Card>
  );
}
