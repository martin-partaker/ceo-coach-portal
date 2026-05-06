'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

interface Props {
  ceo: { id: string; name: string; email: string | null; tenXGoal: string | null };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function RosterEditCeoDialog({ ceo, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(ceo.name);
  const [email, setEmail] = useState(ceo.email ?? '');
  const [tenXGoal, setTenXGoal] = useState(ceo.tenXGoal ?? '');

  const update = trpc.admin.updateCeo.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      // Refresh the roster workspace so an in-flight edit shows up
      // immediately instead of after a navigation. cycleSummary holds the
      // CEO + 10x goal; cycleDetail holds the per-cycle data.
      utils.roster.cycleSummary.invalidate();
      utils.roster.cycleDetail.invalidate();
      onOpenChange(false);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    update.mutate({
      ceoId: ceo.id,
      name: name.trim(),
      email: email.trim() || null,
      tenXGoal: tenXGoal.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit CEO</DialogTitle>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-ceo-name">Name *</Label>
              <Input
                id="edit-ceo-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-ceo-email">Email</Label>
              <Input
                id="edit-ceo-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-ceo-goal">10x goal</Label>
              <Textarea
                id="edit-ceo-goal"
                value={tenXGoal}
                onChange={(e) => setTenXGoal(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          {update.error && (
            <p className="mt-3 text-sm text-destructive">{update.error.message}</p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending || !name.trim()}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
