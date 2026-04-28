'use client';

import { useEffect, useState } from 'react';
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
} from '@/components/ui/dialog';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';

interface Props {
  cycle: {
    id: string;
    label: string;
    periodStart: string | null;
    periodEnd: string | null;
  };
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after the cycle is deleted with the id of a sibling cycle to
   *  switch to (or null if the CEO has no other cycles). The dialog will
   *  also close itself in either case. */
  onDeleted?: (nextCycleId: string | null) => void;
}

export function CycleEditDialog({ cycle, open, onOpenChange, onDeleted }: Props) {
  const utils = trpc.useUtils();
  const [label, setLabel] = useState(cycle.label);
  const [periodStart, setPeriodStart] = useState(cycle.periodStart ?? '');
  const [periodEnd, setPeriodEnd] = useState(cycle.periodEnd ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the local form + confirm state every time the dialog opens for
  // a cycle so the second-step confirm doesn't carry across openings.
  useEffect(() => {
    if (open) {
      setLabel(cycle.label);
      setPeriodStart(cycle.periodStart ?? '');
      setPeriodEnd(cycle.periodEnd ?? '');
      setConfirmDelete(false);
    }
  }, [open, cycle.id, cycle.label, cycle.periodStart, cycle.periodEnd]);

  const update = trpc.roster.updateCycle.useMutation({
    onSuccess: () => {
      utils.roster.cycleSummary.invalidate();
      utils.roster.cycleDetail.invalidate({ cycleId: cycle.id });
      onOpenChange(false);
    },
  });

  const del = trpc.roster.deleteCycle.useMutation({
    onSuccess: ({ nextCycleId }) => {
      utils.roster.cycleSummary.invalidate();
      onOpenChange(false);
      onDeleted?.(nextCycleId);
    },
  });

  const busy = update.isPending || del.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    update.mutate({
      cycleId: cycle.id,
      label: label.trim(),
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit cycle</DialogTitle>
            <DialogDescription>
              Update the cycle&apos;s label or date range. Existing attachments stay attached
              even if you move the dates.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cycle-label">Label *</Label>
              <Input
                id="cycle-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Apr 2026"
                required
                disabled={busy}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cycle-start">Start</Label>
                <Input
                  id="cycle-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cycle-end">End</Label>
                <Input
                  id="cycle-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>
          </div>

          {update.error && (
            <p className="mt-3 text-sm text-destructive">{update.error.message}</p>
          )}
          {del.error && (
            <p className="mt-3 text-sm text-destructive">{del.error.message}</p>
          )}

          {/* Destructive zone — two-step confirm so a misclick doesn't nuke
              a cycle's worth of journals + transcripts + reports. */}
          <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            {!confirmDelete ? (
              <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] text-muted-foreground">
                  Delete this cycle and everything attached to it.
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete cycle
                </Button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-start gap-2 text-[12px] text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    This deletes the cycle&apos;s journals, transcripts, action
                    items, and any generated report. Submissions (raw inputs)
                    are kept and detached for re-triage. This can&apos;t be
                    undone.
                  </span>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => del.mutate({ cycleId: cycle.id })}
                    disabled={busy}
                  >
                    {del.isPending ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Yes, delete cycle
                  </Button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !label.trim()}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
