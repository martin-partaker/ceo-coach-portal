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
  ceo: { id: string; name: string; coachId: string };
  coaches: CoachOption[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function RosterReassignCeoDialog({ ceo, coaches, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const [newCoachId, setNewCoachId] = useState<string | null>(null);

  const reassign = trpc.admin.reassignCeo.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      utils.admin.listCoaches.invalidate();
      onOpenChange(false);
      setNewCoachId(null);
    },
  });

  const otherCoaches = coaches.filter((c) => c.id !== ceo.coachId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign {ceo.name}</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <Label>Move to coach</Label>
          <Select value={newCoachId ?? ''} onValueChange={(v) => setNewCoachId(v || null)}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a coach" />
            </SelectTrigger>
            <SelectContent>
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
            onClick={() => newCoachId && reassign.mutate({ ceoId: ceo.id, newCoachId })}
            disabled={reassign.isPending || !newCoachId}
          >
            {reassign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
