'use client';

import { useMemo, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/api/root';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TeamAvatars } from '@/components/ui/team-avatars';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  Archive as ArchiveIcon,
  Check,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  UserCog,
  UsersRound,
} from 'lucide-react';
import { FormTeamDialog } from './form-team-dialog';

/**
 * Coaching teams admin — list of every team with the bulk of the
 * management surface area: rename + edit 10x goal + capture member
 * roles, transfer the team to a different coach, resync (replays the
 * backfill + parallel-cycle merge for legacy / drifted teams), and
 * archive (which splits each member's inputs back into solo cycles
 * via the split-on-dissolve flow).
 *
 * Page-level auth is via the (app) layout — any signed-in coach can
 * land here but the queries filter to teams they own; super-admins
 * see everything.
 */

type Team = inferRouterOutputs<AppRouter>['teams']['list'][number];

export function TeamsAdminPage() {
  const teamsQ = trpc.teams.list.useQuery();
  const teams = teamsQ.data ?? [];

  const [editTeam, setEditTeam] = useState<Team | null>(null);
  const [transferTeam, setTransferTeam] = useState<Team | null>(null);
  const [archiveTeam, setArchiveTeam] = useState<Team | null>(null);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Coaching teams</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Manage joint coaching engagements — multiple co-founders working
            through the program together as one team. Each team has one coach,
            one shared 10x goal, and produces a single joint report per cycle.
          </p>
        </div>
        <FormTeamDialog />
      </div>

      {teamsQ.isLoading && (
        <div className="flex h-24 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}

      {!teamsQ.isLoading && teams.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-10 text-center">
          <UsersRound className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-3 text-[13px] font-medium">No teams yet</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Form a team from existing CEOs. Inputs from every member feed one
            joint cycle and one joint report.
          </p>
          <div className="mt-4 inline-flex">
            <FormTeamDialog />
          </div>
        </div>
      )}

      {!teamsQ.isLoading && teams.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          {teams.map((team, i) => (
            <TeamRow
              key={team.id}
              team={team}
              isFirst={i === 0}
              onEdit={() => setEditTeam(team)}
              onTransfer={() => setTransferTeam(team)}
              onArchive={() => setArchiveTeam(team)}
            />
          ))}
        </div>
      )}

      {editTeam && (
        <EditTeamDialog
          team={editTeam}
          open={!!editTeam}
          onOpenChange={(o) => {
            if (!o) setEditTeam(null);
          }}
        />
      )}
      {transferTeam && (
        <TransferCoachDialog
          team={transferTeam}
          open={!!transferTeam}
          onOpenChange={(o) => {
            if (!o) setTransferTeam(null);
          }}
        />
      )}
      {archiveTeam && (
        <ArchiveTeamDialog
          team={archiveTeam}
          open={!!archiveTeam}
          onOpenChange={(o) => {
            if (!o) setArchiveTeam(null);
          }}
        />
      )}
    </div>
  );
}

function TeamRow({
  team,
  isFirst,
  onEdit,
  onTransfer,
  onArchive,
}: {
  team: Team;
  isFirst: boolean;
  onEdit: () => void;
  onTransfer: () => void;
  onArchive: () => void;
}) {
  const utils = trpc.useUtils();
  const resync = trpc.teams.resync.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.teams.list.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
    },
  });

  return (
    <div
      className={cn(
        'flex items-center gap-4 px-4 py-3',
        !isFirst && 'border-t border-border',
        team.archivedAt && 'opacity-60',
      )}
    >
      <TeamAvatars
        members={team.members.map((m) => ({
          id: m.id,
          name: m.name,
          avatarUrl: m.avatarUrl,
        }))}
        size="sm"
        max={3}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{team.name}</span>
          {team.archivedAt && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              archived
            </span>
          )}
        </div>
        <p className="truncate text-[11.5px] text-muted-foreground">
          {team.members.map((m) => m.name).join(' & ')}
          {team.companyName && team.companyName !== team.name
            ? ` · ${team.companyName}`
            : ''}
        </p>
        {team.tenXGoal && (
          <p className="mt-0.5 line-clamp-1 text-[11px] italic text-muted-foreground/80">
            10x: {team.tenXGoal}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {resync.isPending ? (
          <span className="text-[10px] text-muted-foreground">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            Resyncing…
          </span>
        ) : (
          resync.data && (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
              <Check className="mr-0.5 inline h-3 w-3" />
              {resync.data.merged.cyclesDeleted > 0
                ? `merged ${resync.data.merged.cyclesDeleted} cycle${resync.data.merged.cyclesDeleted === 1 ? '' : 's'}`
                : 'in sync'}
            </span>
          )
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="Team actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onEdit} disabled={!!team.archivedAt}>
              <Pencil className="mr-2 h-3 w-3" />
              Edit team
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onTransfer}
              disabled={!!team.archivedAt}
            >
              <UserCog className="mr-2 h-3 w-3" />
              Transfer coach
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => resync.mutate({ teamId: team.id })}
              disabled={resync.isPending || !!team.archivedAt}
            >
              <RefreshCw className="mr-2 h-3 w-3" />
              Resync data
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onArchive}
              disabled={!!team.archivedAt}
              className="text-destructive focus:text-destructive"
            >
              <ArchiveIcon className="mr-2 h-3 w-3" />
              Archive team
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function EditTeamDialog({
  team,
  open,
  onOpenChange,
}: {
  team: Team;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(team.name);
  const [companyName, setCompanyName] = useState(team.companyName ?? '');
  const [tenXGoal, setTenXGoal] = useState(team.tenXGoal ?? '');
  const [memberRoles, setMemberRoles] = useState<Record<string, string>>(
    Object.fromEntries(team.members.map((m) => [m.id, m.memberRole ?? ''])),
  );

  const update = trpc.teams.update.useMutation({
    onSuccess: async () => {
      await utils.teams.list.invalidate();
      onOpenChange(false);
    },
  });

  function save() {
    update.mutate({
      teamId: team.id,
      name: name.trim(),
      companyName: companyName.trim() || null,
      tenXGoal: tenXGoal.trim() || null,
      memberRoles: team.members.map((m) => ({
        ceoId: m.id,
        role: (memberRoles[m.id] ?? '').trim() || null,
      })),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit team</DialogTitle>
          <DialogDescription>
            Update the team&apos;s name, shared 10x goal, and member roles.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ed-name" className="text-[12px]">
                Team name
              </Label>
              <Input
                id="ed-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ed-company" className="text-[12px]">
                Company name (optional)
              </Label>
              <Input
                id="ed-company"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="h-9"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ed-10x" className="text-[12px]">
              Shared 10x goal
            </Label>
            <Textarea
              id="ed-10x"
              value={tenXGoal}
              onChange={(e) => setTenXGoal(e.target.value)}
              rows={3}
              className="text-[12px]"
              placeholder="The team's 3-year destination..."
            />
          </div>

          <div className="space-y-2">
            <Label className="text-[12px]">Members</Label>
            {team.members.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <span className="w-32 shrink-0 truncate text-[12.5px] font-medium">
                  {m.name}
                </span>
                <Input
                  value={memberRoles[m.id] ?? ''}
                  onChange={(e) =>
                    setMemberRoles((prev) => ({
                      ...prev,
                      [m.id]: e.target.value,
                    }))
                  }
                  placeholder='Role (optional) — e.g. "CEO", "COO"'
                  className="h-8 flex-1 text-[12px]"
                />
              </div>
            ))}
          </div>

          {update.error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
              {update.error.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={update.isPending || !name.trim()}>
            {update.isPending && (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferCoachDialog({
  team,
  open,
  onOpenChange,
}: {
  team: Team;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const coachesQ = trpc.admin.listCoaches.useQuery(undefined, { enabled: open });
  const [newCoachId, setNewCoachId] = useState<string>('');

  const transfer = trpc.teams.transferCoach.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.teams.list.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
      onOpenChange(false);
    },
  });

  const coaches = useMemo(
    () => (coachesQ.data ?? []).filter((c) => c.id !== team.coachId),
    [coachesQ.data, team.coachId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer coach</DialogTitle>
          <DialogDescription>
            Move <span className="font-medium">{team.name}</span> to a different
            coach. The team and every member&apos;s coach assignment are
            updated together.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[12px]">New coach</Label>
            <Select value={newCoachId} onValueChange={setNewCoachId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Pick a coach…" />
              </SelectTrigger>
              <SelectContent>
                {coaches.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {transfer.error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
              {transfer.error.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={transfer.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              newCoachId &&
              transfer.mutate({ teamId: team.id, newCoachId })
            }
            disabled={!newCoachId || transfer.isPending}
          >
            {transfer.isPending && (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            )}
            Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveTeamDialog({
  team,
  open,
  onOpenChange,
}: {
  team: Team;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const archive = trpc.teams.archive.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.teams.list.invalidate(),
        utils.teams.listFormCandidates.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Archive {team.name}?
          </DialogTitle>
          <DialogDescription className="pt-1">
            Every member becomes a solo CEO again. We&apos;ll reconstruct each
            member&apos;s cycles from their own authored inputs so nobody walks
            away with empty history. The team row is kept (soft-deleted) so
            historical references can still resolve a name.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
          <li>
            • Members ({team.members.length}):{' '}
            {team.members.map((m) => m.name).join(', ')}
          </li>
          <li>• Shared 10x goal is preserved on the team row for history.</li>
          <li>
            • Each member&apos;s authored journals + transcripts move to their
            new solo cycles.
          </li>
          <li>
            • Generated reports stay attached to their original cycle&apos;s
            canonical owner.
          </li>
        </ul>

        {archive.error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            {archive.error.message}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={archive.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => archive.mutate({ teamId: team.id })}
            disabled={archive.isPending}
          >
            {archive.isPending && (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            )}
            Archive team
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
