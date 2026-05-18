'use client';

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { cn } from '@/lib/utils';
import { Loader2, Users, Check, AlertTriangle } from 'lucide-react';

/**
 * "Form team" — turn 2+ existing solo CEOs into a coaching team.
 *
 * The dialog enforces two invariants the backend will otherwise reject:
 *   1. Every selected CEO must already share one coach.
 *   2. No selected CEO can already be in another team.
 *
 * We surface those checks live as the user picks so they don't hit a
 * server error after composing a 4-person selection.
 *
 * After creation, future cycles for any member should be created
 * team-aware. Pre-existing solo cycles are NOT retroactively moved —
 * they stay attached to the lead member's history. (We can build a
 * "merge prior cycles" tool later if it's needed.)
 */

interface Props {
  /** Optional trigger override — defaults to a "Form team" button. */
  trigger?: React.ReactNode;
}

export function FormTeamDialog({ trigger }: Props) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const candidatesQ = trpc.teams.listFormCandidates.useQuery(undefined, {
    enabled: open,
    staleTime: 30_000,
  });

  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Per-member role free-text. Surfaces in the prompt under "Team
   *  Profile" so the model can give role-specific feedback ("David,
   *  you on strategy / Dave, you on ops"). Optional — null when blank. */
  const [memberRoles, setMemberRoles] = useState<Record<string, string>>({});
  /** Which member's 10x goal to seed the team's shared goal from. When
   *  multiple selected members already have a personal 10x goal we let
   *  the operator pick instead of silently dropping one. */
  const [goalSeedId, setGoalSeedId] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Drop the role + goal seed if the member is no longer selected.
    setMemberRoles((prev) => {
      if (!selected.has(id)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setGoalSeedId((cur) => (cur === id ? null : cur));
  }

  function reset() {
    setName('');
    setCompanyName('');
    setSelected(new Set());
    setMemberRoles({});
    setGoalSeedId(null);
  }

  const candidates = candidatesQ.data ?? [];
  const selectedRows = useMemo(
    () => candidates.filter((c) => selected.has(c.id)),
    [candidates, selected],
  );

  // Selected members who already have a personal 10x goal. The dialog
  // surfaces these so the coach can choose which one seeds the team's
  // shared goal (instead of the previous "most recently updated wins,
  // silently" behavior).
  const goalCandidates = useMemo(
    () => selectedRows.filter((m) => m.tenXGoal?.trim()),
    [selectedRows],
  );

  // Auto-pick the goal seed when the list of goal-having members
  // changes: default to the first one. Coach can override.
  useEffect(() => {
    if (goalCandidates.length === 0) {
      if (goalSeedId !== null) setGoalSeedId(null);
      return;
    }
    if (!goalSeedId || !goalCandidates.some((g) => g.id === goalSeedId)) {
      setGoalSeedId(goalCandidates[0].id);
    }
  }, [goalCandidates, goalSeedId]);

  // Validation: at least 2 members, all sharing one coach (or being
  // unassigned, which the backend now handles by syncing to the team's
  // resolved coach).
  const selectedCoachIds = new Set(
    selectedRows.map((c) => c.coachId).filter((id): id is string => !!id),
  );
  const tooFew = selectedRows.length < 2;
  const multipleCoaches = selectedCoachIds.size > 1;
  const noCoach = selectedRows.length > 0 && selectedCoachIds.size === 0;
  const canSubmit =
    !tooFew && !multipleCoaches && !noCoach && name.trim().length > 0;

  const validationMessage = tooFew
    ? selectedRows.length === 0
      ? 'Pick at least 2 CEOs.'
      : 'A team needs at least 2 members.'
    : multipleCoaches
      ? 'These CEOs are on different coaches — reassign them to one coach first.'
      : noCoach
        ? 'At least one CEO needs a coach assigned.'
        : null;

  const formMutation = trpc.teams.formFromMembers.useMutation({
    onSuccess: async (res) => {
      // Persist member roles + the chosen 10x goal seed via the update
      // endpoint so they land on the same team in one trip. The form
      // endpoint itself doesn't take roles to keep its signature lean.
      const rolePayload = selectedRows
        .map((m) => ({ ceoId: m.id, role: (memberRoles[m.id] ?? '').trim() || null }))
        .filter((r) => r.role !== null || true); // include null to clear stale roles
      const seededGoal = goalSeedId
        ? selectedRows.find((m) => m.id === goalSeedId)?.tenXGoal ?? null
        : null;
      if (rolePayload.length > 0 || (seededGoal && seededGoal.trim())) {
        try {
          await updateTeam.mutateAsync({
            teamId: res.team.id,
            memberRoles: rolePayload,
            ...(seededGoal && seededGoal.trim() ? { tenXGoal: seededGoal } : {}),
          });
        } catch (e) {
          // Non-fatal — the team is already formed; the coach can edit
          // roles later from the team management view.
          console.warn('[FormTeamDialog] role/goal patch failed', e);
        }
      }

      await Promise.all([
        utils.teams.list.invalidate(),
        utils.teams.listFormCandidates.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
      setOpen(false);
      reset();
    },
  });

  const updateTeam = trpc.teams.update.useMutation();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || formMutation.isPending) return;
    formMutation.mutate({
      name: name.trim(),
      companyName: companyName.trim() || undefined,
      memberCeoIds: Array.from(selected),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          reset();
          formMutation.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="h-7 text-xs">
            <Users className="mr-1.5 h-3 w-3" />
            Form team
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Form a coaching team</DialogTitle>
            <DialogDescription>
              Combine two or more CEOs who are working through the program
              together (e.g. co-founders of the same company). They&apos;ll
              share one 10x goal, one set of company KPIs, and one joint
              monthly report from the next cycle onward.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="team-name" className="text-[12px]">
                  Team name
                </Label>
                <Input
                  id="team-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Tipton Mills Foods"
                  required
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="team-company" className="text-[12px]">
                  Company name (optional)
                </Label>
                <Input
                  id="team-company"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Legal name if different"
                  className="h-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[12px]">
                Members ({selectedRows.length} selected)
              </Label>
              <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/10">
                {candidatesQ.isLoading && (
                  <div className="flex h-32 items-center justify-center text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                )}
                {!candidatesQ.isLoading && candidates.length === 0 && (
                  <p className="px-4 py-6 text-center text-[12px] text-muted-foreground">
                    No solo CEOs available. Every CEO on your roster is
                    already part of a team — or you haven&apos;t added any
                    yet.
                  </p>
                )}
                {candidates.map((c) => {
                  const isSelected = selected.has(c.id);
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'border-b border-border/70 last:border-b-0',
                        isSelected ? 'bg-blue-500/10' : '',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggle(c.id)}
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors',
                          !isSelected && 'hover:bg-muted/30',
                        )}
                      >
                        <span
                          className={cn(
                            'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                            isSelected
                              ? 'border-blue-500 bg-blue-500 text-white'
                              : 'border-border bg-background',
                          )}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </span>
                        <CeoAvatar
                          name={c.name}
                          avatarUrl={c.avatarUrl}
                          size="sm"
                          className="rounded-full"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {c.name}
                          </span>
                          <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                            {c.email ?? 'no email'}
                          </span>
                        </span>
                      </button>
                      {/* Per-member role input — only revealed when
                          selected. Surfaces in the prompt so the model
                          can give role-specific feedback. */}
                      {isSelected && (
                        <div className="border-t border-border/40 bg-background/60 px-3 py-2">
                          <Input
                            value={memberRoles[c.id] ?? ''}
                            onChange={(e) =>
                              setMemberRoles((prev) => ({
                                ...prev,
                                [c.id]: e.target.value,
                              }))
                            }
                            placeholder='Role (optional) — e.g. "CEO", "Co-CEO", "COO"'
                            className="h-7 text-[12px]"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 10x goal seed picker. Surfaces when ≥1 selected member
                has an existing personal 10x goal so the coach can pick
                which one seeds the team's shared goal (instead of
                silently dropping the others). Hidden when nothing to
                seed from. */}
            {goalCandidates.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-[12px]">
                  Seed the team&apos;s 10x goal from
                </Label>
                <div className="space-y-1.5">
                  {goalCandidates.map((g) => (
                    <label
                      key={g.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-[12px]',
                        goalSeedId === g.id
                          ? 'border-blue-500/40 bg-blue-500/5'
                          : 'border-border hover:bg-muted/30',
                      )}
                    >
                      <input
                        type="radio"
                        name="goal-seed"
                        value={g.id}
                        checked={goalSeedId === g.id}
                        onChange={() => setGoalSeedId(g.id)}
                        className="mt-0.5 shrink-0"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          {g.name}
                        </span>
                        <span className="mt-0.5 text-foreground/80">
                          {g.tenXGoal}
                        </span>
                      </span>
                    </label>
                  ))}
                  <label
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[12px] text-muted-foreground',
                      goalSeedId === null
                        ? 'border-blue-500/40 bg-blue-500/5'
                        : 'border-dashed border-border hover:bg-muted/30',
                    )}
                  >
                    <input
                      type="radio"
                      name="goal-seed"
                      value=""
                      checked={goalSeedId === null}
                      onChange={() => setGoalSeedId(null)}
                      className="shrink-0"
                    />
                    Don&apos;t seed — write the team&apos;s 10x from scratch later
                  </label>
                </div>
              </div>
            )}

            {validationMessage && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{validationMessage}</span>
              </div>
            )}

            {formMutation.error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
                {formMutation.error.message}
              </p>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={formMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || formMutation.isPending}
            >
              {formMutation.isPending && (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              )}
              Form team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
