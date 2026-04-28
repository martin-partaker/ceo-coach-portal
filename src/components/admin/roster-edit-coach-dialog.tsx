'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

interface Props {
  coach: { id: string; name: string; email: string; zoomUserEmail: string | null };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function RosterEditCoachDialog({ coach, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(coach.name);
  const [email, setEmail] = useState(coach.email);
  const [zoomEmail, setZoomEmail] = useState(coach.zoomUserEmail ?? '');

  const update = trpc.admin.updateCoach.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      utils.admin.listCoaches.invalidate();
      onOpenChange(false);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    update.mutate({
      coachId: coach.id,
      name: name.trim(),
      email: email.trim(),
      zoomUserEmail: zoomEmail.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit coach</DialogTitle>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-coach-name">Name *</Label>
              <Input
                id="edit-coach-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-coach-email">Email *</Label>
              <Input
                id="edit-coach-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-coach-zoom">Zoom email</Label>
              <Input
                id="edit-coach-zoom"
                type="email"
                value={zoomEmail}
                onChange={(e) => setZoomEmail(e.target.value)}
                placeholder="(optional)"
              />
              <p className="text-[11px] text-muted-foreground">
                Used to attribute Zoom transcripts. Often the same as the primary email.
              </p>
            </div>
          </div>

          {update.error && (
            <p className="mt-3 text-sm text-destructive">{update.error.message}</p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending || !name.trim() || !email.trim()}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
