'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';

interface CoachOption {
  id: string;
  name: string;
  email: string;
}

interface Props {
  ceo: { id: string; name: string; coachId: string | null };
  coaches: CoachOption[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const UNASSIGN_VALUE = '__unassigned__';

export function RosterReassignCeoDialog({ ceo, coaches, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  // `undefined` here means "user hasn't picked yet"; `null` means
  // "user explicitly chose Unassigned"; a string is a coach id.
  const [pick, setPick] = useState<string | null | undefined>(undefined);

  const reassign = trpc.admin.reassignCeo.useMutation({
    onSuccess: async () => {
      onOpenChange(false);
      setPick(undefined);
      await Promise.all([
        utils.admin.listAllCeos.invalidate(),
        utils.admin.listCoaches.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
    },
  });

  const otherCoaches = coaches.filter((c) => c.id !== ceo.coachId);
  const canSubmit = pick !== undefined && pick !== ceo.coachId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign {ceo.name}</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <Label>Move to coach</Label>
          <Select
            value={pick === null ? UNASSIGN_VALUE : pick ?? ''}
            onValueChange={(v) => setPick(v === UNASSIGN_VALUE ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a coach" />
            </SelectTrigger>
            <SelectContent>
              {ceo.coachId !== null && (
                <SelectItem value={UNASSIGN_VALUE}>
                  <span className="text-muted-foreground">— Unassigned —</span>
                </SelectItem>
              )}
              {otherCoaches.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} <span className="text-muted-foreground">· {c.email}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {reassign.error && (
          <p className="mt-3 text-sm text-destructive">{reassign.error.message}</p>
        )}

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              canSubmit && reassign.mutate({ ceoId: ceo.id, newCoachId: pick ?? null })
            }
            disabled={reassign.isPending || !canSubmit}
          >
            {reassign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
