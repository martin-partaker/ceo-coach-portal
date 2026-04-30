'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  CheckCircle2,
  ListChecks,
  Loader2,
  Trash2,
} from 'lucide-react';

type Mode = 'release' | 'destroy';

interface Props {
  ceo: { id: string; name: string; cycleCount: number; inputCount?: number };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function RosterDeleteCeoDialog({ ceo, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const inputCount = ceo.inputCount ?? 0;
  const hasData = ceo.cycleCount > 0 || inputCount > 0;

  const [mode, setMode] = useState<Mode>(hasData ? 'release' : 'destroy');
  const [released, setReleased] = useState<number | null>(null);

  // Reset when reopened so the radio reflects the current CEO's state.
  useEffect(() => {
    if (open) {
      setMode(hasData ? 'release' : 'destroy');
      setReleased(null);
    }
  }, [open, hasData]);

  const del = trpc.admin.deleteCeo.useMutation({
    onSuccess: (data) => {
      utils.admin.listAllCeos.invalidate();
      utils.admin.listCoaches.invalidate();
      utils.roster.cycleSummary.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
      if (mode === 'release') {
        setReleased(data?.released ?? 0);
      } else {
        onOpenChange(false);
      }
    },
  });

  // Success state — only shown after a successful release.
  if (released !== null) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              {ceo.name} removed
            </DialogTitle>
            <DialogDescription className="pt-1">
              {released > 0 ? (
                <>
                  <span className="tabular-nums font-medium text-foreground">
                    {released}
                  </span>{' '}
                  input{released === 1 ? '' : 's'} released back to Triage.
                  Re-assign {released === 1 ? 'it' : 'them'} to the correct CEO.
                </>
              ) : (
                <>No inputs needed re-triaging.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
            {released > 0 && (
              <Button asChild>
                <Link href="/admin/triage">
                  Open Triage
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {ceo.name}?</DialogTitle>
          {!hasData && (
            <DialogDescription className="pt-1">
              This CEO has no attached data. Permanent and cannot be undone.
            </DialogDescription>
          )}
          {hasData && (
            <DialogDescription className="pt-1">
              {ceo.name} has{' '}
              {inputCount > 0 && (
                <>
                  <span className="tabular-nums font-medium text-foreground">
                    {inputCount}
                  </span>{' '}
                  input{inputCount === 1 ? '' : 's'}
                  {ceo.cycleCount > 0 && ' across '}
                </>
              )}
              {ceo.cycleCount > 0 && (
                <>
                  <span className="tabular-nums font-medium text-foreground">
                    {ceo.cycleCount}
                  </span>{' '}
                  cycle{ceo.cycleCount === 1 ? '' : 's'}
                </>
              )}
              . Choose what to do with the data:
            </DialogDescription>
          )}
        </DialogHeader>

        {hasData && (
          <div className="mt-3 space-y-2">
            <RadioCard
              selected={mode === 'release'}
              onSelect={() => setMode('release')}
              icon={<ListChecks className="h-4 w-4" />}
              title="Release inputs back to Triage"
              body={
                inputCount > 0
                  ? `${inputCount} input${inputCount === 1 ? '' : 's'} become pending again so you can re-assign ${inputCount === 1 ? 'it' : 'them'} to the correct CEO. Cycles, journals, and reports are removed.`
                  : 'Cycles, journals, and reports are removed.'
              }
              recommended
            />
            <RadioCard
              selected={mode === 'destroy'}
              onSelect={() => setMode('destroy')}
              icon={<Trash2 className="h-4 w-4" />}
              title="Permanently delete everything"
              body="Wipes the inputs, projections, cycles, and reports. Use only for test data or true junk."
              tone="destructive"
            />
          </div>
        )}

        {del.error && (
          <p className="mt-3 text-sm text-destructive">{del.error.message}</p>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={mode === 'destroy' ? 'destructive' : 'default'}
            onClick={() =>
              del.mutate({
                ceoId: ceo.id,
                releaseInputs: mode === 'release',
              })
            }
            disabled={del.isPending}
          >
            {del.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : mode === 'release' ? (
              <ListChecks className="mr-2 h-4 w-4" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {mode === 'release' ? 'Release & delete' : 'Delete CEO'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RadioCard({
  selected,
  onSelect,
  icon,
  title,
  body,
  recommended = false,
  tone = 'default',
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  recommended?: boolean;
  tone?: 'default' | 'destructive';
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected
          ? tone === 'destructive'
            ? 'border-destructive/50 bg-destructive/5'
            : 'border-foreground/40 bg-muted/40'
          : 'border-border hover:bg-muted/30'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
          selected
            ? tone === 'destructive'
              ? 'border-destructive bg-destructive text-destructive-foreground'
              : 'border-foreground bg-foreground text-background'
            : 'border-border'
        )}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'text-muted-foreground',
              selected && tone === 'destructive' && 'text-destructive'
            )}
          >
            {icon}
          </span>
          <p className="text-sm font-medium">{title}</p>
          {recommended && (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              recommended
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{body}</p>
      </div>
    </button>
  );
}
