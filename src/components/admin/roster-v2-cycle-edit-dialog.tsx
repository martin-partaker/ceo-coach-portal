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
  cycle: {
    id: string;
    label: string;
    periodStart: string | null;
    periodEnd: string | null;
  };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function CycleEditDialog({ cycle, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const [label, setLabel] = useState(cycle.label);
  const [periodStart, setPeriodStart] = useState(cycle.periodStart ?? '');
  const [periodEnd, setPeriodEnd] = useState(cycle.periodEnd ?? '');

  const update = trpc.roster.updateCycle.useMutation({
    onSuccess: () => {
      utils.roster.cycleSummary.invalidate();
      utils.roster.cycleDetail.invalidate({ cycleId: cycle.id });
      onOpenChange(false);
    },
  });

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
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cycle-end">End</Label>
                <Input
                  id="cycle-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
          </div>

          {update.error && (
            <p className="mt-3 text-sm text-destructive">{update.error.message}</p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending || !label.trim()}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
