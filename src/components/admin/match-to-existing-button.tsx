'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Loader2, Search, Link2 } from 'lucide-react';

interface Props {
  rawInputId: string;
  /** Email present in the submission; offered as an alias to add. */
  submissionEmail?: string | null;
  /** Called after a successful match — useful for parent state updates (e.g. triage walkthrough advancing the queue). */
  onMatched?: () => void;
}

export function MatchToExistingButton({ rawInputId, submissionEmail, onMatched }: Props) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [addAlias, setAddAlias] = useState(true);

  const { data: rows, isLoading } = trpc.admin.listAllCeos.useQuery(undefined, {
    enabled: open,
  });

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const inName = r.ceo.name.toLowerCase().includes(q);
      const inEmail = (r.ceo.email ?? '').toLowerCase().includes(q);
      const inAlias = r.aliasEmails.some((e) => e.toLowerCase().includes(q));
      const inCoach = r.coach.name.toLowerCase().includes(q);
      return inName || inEmail || inAlias || inCoach;
    });
  }, [rows, query]);

  const assign = trpc.inbox.assignToCeo.useMutation({
    onSuccess: (data) => {
      utils.inbox.listPending.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
      if (data?.autoResolved && data.autoResolved > 0) {
        console.info(`Assigned; auto-resolved ${data.autoResolved} more pending row(s).`);
      }
      onMatched?.();
      setOpen(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Link2 className="mr-1.5 h-3.5 w-3.5" />
          Match
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Match to an existing CEO</DialogTitle>
          <DialogDescription>
            Pick the CEO this submission belongs to. Searches across all coaches.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, alias, or coach…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
              autoFocus
            />
          </div>

          {submissionEmail && (
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
              <Checkbox
                id="add-alias"
                checked={addAlias}
                onCheckedChange={(c) => setAddAlias(c === true)}
              />
              <Label htmlFor="add-alias" className="cursor-pointer text-xs font-normal">
                Add{' '}
                <span className="font-mono text-foreground">{submissionEmail}</span> as
                an alias for the chosen CEO
              </Label>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {isLoading && (
              <div className="flex items-center justify-center p-6">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!isLoading && filtered.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {query ? 'No matches.' : 'No CEOs in the system yet.'}
              </p>
            )}
            <div className="divide-y divide-border">
              {filtered.map(({ ceo, coach, aliasEmails }) => (
                <button
                  key={ceo.id}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-50"
                  onClick={() =>
                    assign.mutate({
                      rawInputId,
                      ceoId: ceo.id,
                      addAliasFromSubmission: !!submissionEmail && addAlias,
                    })
                  }
                  disabled={assign.isPending}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{ceo.name}</p>
                    <p className="truncate text-xs text-muted-foreground font-mono">
                      {ceo.email ?? '(no primary email)'}
                      {aliasEmails.length > 1 && (
                        <span className="ml-1 text-muted-foreground/70">
                          +{aliasEmails.length - 1}
                        </span>
                      )}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {coach.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {assign.error && (
          <p className="mt-2 text-sm text-destructive">{assign.error.message}</p>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
