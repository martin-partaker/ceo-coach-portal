'use client';

import { useMemo, useState } from 'react';
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

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    setName('');
    setCompanyName('');
    setSelected(new Set());
  }

  const candidates = candidatesQ.data ?? [];
  const selectedRows = useMemo(
    () => candidates.filter((c) => selected.has(c.id)),
    [candidates, selected],
  );

  // Validation: at least 2 members, all sharing one coach.
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
    onSuccess: async () => {
      await Promise.all([
        utils.teams.list.invalidate(),
        utils.teams.listFormCandidates.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
      setOpen(false);
      reset();
    },
  });

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
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggle(c.id)}
                      className={cn(
                        'flex w-full items-center gap-3 border-b border-border/70 px-3 py-2 text-left text-[13px] transition-colors last:border-b-0',
                        isSelected ? 'bg-blue-500/10' : 'hover:bg-muted/30',
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
                  );
                })}
              </div>
            </div>

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
