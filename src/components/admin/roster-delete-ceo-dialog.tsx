'use client';

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
import { Loader2, Trash2 } from 'lucide-react';

interface Props {
  ceo: { id: string; name: string; cycleCount: number };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function RosterDeleteCeoDialog({ ceo, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();

  const del = trpc.admin.deleteCeo.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      utils.admin.listCoaches.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {ceo.name}?</DialogTitle>
          <DialogDescription className="space-y-2 pt-1">
            <span className="block">This is permanent and cannot be undone.</span>
            <span className="block text-destructive">
              All of this CEO&apos;s data will be deleted:{' '}
              {ceo.cycleCount} cycle{ceo.cycleCount === 1 ? '' : 's'}, weekly journals,
              transcripts, action items, reports, and any pending inbox rows.
            </span>
          </DialogDescription>
        </DialogHeader>

        {del.error && (
          <p className="mt-3 text-sm text-destructive">{del.error.message}</p>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => del.mutate({ ceoId: ceo.id })}
            disabled={del.isPending}
          >
            {del.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Delete CEO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
