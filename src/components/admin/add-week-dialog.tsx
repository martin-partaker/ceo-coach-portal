'use client';

import { useEffect, useState } from 'react';
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
import { Loader2, Plus } from 'lucide-react';

interface Props {
  cycleId: string;
  /** Cycle's date window — used to bound the date picker and seed a
   *  sensible default. Either bound may be null for legacy cycles. */
  cyclePeriodStart: string | null;
  cyclePeriodEnd: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Default the picker to today, clamped into the cycle's window. */
function defaultDate(start: string | null, end: string | null): string {
  const today = todayIso();
  if (start && today < start) return start;
  if (end && today > end) return end;
  return today;
}

/**
 * Day-precise journal entry dialog. The component was originally a "week"
 * picker; the user now picks an exact date and we derive the legacy
 * weekNumber column on the server.
 */
export function AddWeekDialog({
  cycleId,
  cyclePeriodStart,
  cyclePeriodEnd,
  open,
  onOpenChange,
}: Props) {
  const utils = trpc.useUtils();
  const [entryDate, setEntryDate] = useState<string>(() =>
    defaultDate(cyclePeriodStart, cyclePeriodEnd),
  );
  const [content, setContent] = useState('');

  useEffect(() => {
    if (open) {
      setEntryDate(defaultDate(cyclePeriodStart, cyclePeriodEnd));
      setContent('');
    }
  }, [open, cyclePeriodStart, cyclePeriodEnd]);

  const add = trpc.cycles.addJournal.useMutation({
    onSuccess: () => {
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
      onOpenChange(false);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!entryDate) return;
    add.mutate({
      cycleId,
      entryDate,
      content: content.trim() || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add a journal entry</DialogTitle>
            <DialogDescription>
              Pick the day this entry refers to. You can leave content blank
              and fill it in later from the cycle page.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="aw-date">Date</Label>
              <Input
                id="aw-date"
                type="date"
                value={entryDate}
                min={cyclePeriodStart ?? undefined}
                max={cyclePeriodEnd ?? undefined}
                onChange={(e) => setEntryDate(e.target.value)}
                required
                className="w-fit"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="aw-content">Content</Label>
              <Textarea
                id="aw-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Paste this day's journal here…"
                rows={10}
                className="text-sm leading-relaxed"
                autoFocus
              />
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {content.length.toLocaleString()} chars
              </p>
            </div>
          </div>

          {add.error && (
            <p className="mt-3 text-sm text-destructive">{add.error.message}</p>
          )}

          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending || !entryDate}>
              {add.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Add entry
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

