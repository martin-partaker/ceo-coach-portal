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
import { Loader2, Trash2, AlertCircle } from 'lucide-react';

interface Props {
  coach: { id: string; name: string };
  ceoCount: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function RosterDeleteCoachDialog({ coach, ceoCount, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();

  const del = trpc.admin.deleteCoach.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      utils.admin.listCoaches.invalidate();
      onOpenChange(false);
    },
  });

  const blocked = ceoCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete coach {coach.name}?</DialogTitle>
          <DialogDescription className="pt-1">
            {blocked ? (
              <span className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3 text-amber-700 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  This coach has{' '}
                  <span className="font-semibold">
                    {ceoCount} CEO{ceoCount === 1 ? '' : 's'}
                  </span>{' '}
                  assigned. Reassign or delete them before removing this coach.
                </span>
              </span>
            ) : (
              <span>This is permanent and cannot be undone.</span>
            )}
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
            onClick={() => del.mutate({ coachId: coach.id })}
            disabled={del.isPending || blocked}
          >
            {del.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Delete coach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
