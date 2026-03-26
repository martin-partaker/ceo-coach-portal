'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Plus, Loader2 } from 'lucide-react';

interface CreateCycleDialogProps {
  ceoId: string;
}

export function CreateCycleDialog({ ceoId }: CreateCycleDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');

  const createCycle = trpc.cycles.create.useMutation({
    onSuccess: (created) => {
      setOpen(false);
      setLabel('');
      setPeriodStart('');
      setPeriodEnd('');
      router.push(`/ceos/${ceoId}/cycles/${created.id}`);
      router.refresh();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createCycle.mutate({
      ceoId,
      label: label.trim(),
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
    });
  }

  // Generate a default label like "Mar 26 → Apr 26"
  function generateDefaults() {
    const end = periodEnd ? new Date(periodEnd) : new Date();
    const start = periodStart
      ? new Date(periodStart)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const toIso = (d: Date) => d.toISOString().split('T')[0];
    setLabel(`${fmt(start)} → ${fmt(end)}`);
    if (!periodStart) setPeriodStart(toIso(start));
    if (!periodEnd) setPeriodEnd(toIso(end));
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          New Session
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New coaching session</DialogTitle>
            <DialogDescription>
              Start a new coaching session period. Dates are optional.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cycle-label">Label *</Label>
              <div className="flex gap-2">
                <Input
                  id="cycle-label"
                  placeholder='e.g. "Mar 26 → Apr 26"'
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={generateDefaults}
                  className="shrink-0 text-xs"
                >
                  Auto
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="cycle-start">Start date</Label>
                <Input
                  id="cycle-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cycle-end">End date</Label>
                <Input
                  id="cycle-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
          </div>

          {createCycle.error && (
            <p className="mt-3 text-sm text-destructive">
              {createCycle.error.message}
            </p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createCycle.isPending || !label.trim()}>
              {createCycle.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
