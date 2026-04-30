'use client';

import { useState } from 'react';
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
import { Loader2 } from 'lucide-react';

interface Props {
  ceoId: string;
  ceoName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called with the newly-created cycle id so the workspace can switch to it. */
  onCreated?: (cycleId: string) => void;
}

function defaultMonthlyRange(): { label: string; start: string; end: string } {
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m];
  return {
    label: `${month} ${y}`,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export function CycleCreateDialog({ ceoId, ceoName, open, onOpenChange, onCreated }: Props) {
  const utils = trpc.useUtils();
  const defaults = defaultMonthlyRange();
  const [label, setLabel] = useState(defaults.label);
  const [periodStart, setPeriodStart] = useState(defaults.start);
  const [periodEnd, setPeriodEnd] = useState(defaults.end);

  const create = trpc.roster.createCycle.useMutation({
    // Await the cycleSummary invalidation BEFORE flipping the active tab.
    // Otherwise the row's "reset active id when not in cycles list" effect
    // fires before the new cycle has loaded and snaps us back to the old
    // tab. Awaiting keeps the workspace's tab strip honest.
    onSuccess: async (cycle) => {
      await utils.roster.cycleSummary.invalidate();
      onCreated?.(cycle.id);
      onOpenChange(false);
      // Re-prime defaults for the next time
      const next = defaultMonthlyRange();
      setLabel(next.label);
      setPeriodStart(next.start);
      setPeriodEnd(next.end);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    create.mutate({
      ceoId,
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
            <DialogTitle>New cycle for {ceoName}</DialogTitle>
            <DialogDescription>
              Defaults to the current calendar month. Adjust the label or dates if your
              cadence is different (cycles don&apos;t need to be calendar-aligned).
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-cycle-label">Label *</Label>
              <Input
                id="new-cycle-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-cycle-start">Start</Label>
                <Input
                  id="new-cycle-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-cycle-end">End</Label>
                <Input
                  id="new-cycle-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
          </div>

          {create.error && (
            <p className="mt-3 text-sm text-destructive">{create.error.message}</p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !label.trim()}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create cycle
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
