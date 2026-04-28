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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Loader2 } from 'lucide-react';

interface CoachOption {
  id: string;
  name: string;
  email: string;
}

interface Props {
  /** Coaches the dialog can assign the new CEO to. */
  coaches: CoachOption[];
  /** Pre-select a coach (e.g. from a per-section "+ Add CEO" button). */
  defaultCoachId?: string | null;
  triggerLabel?: string;
  triggerVariant?: 'default' | 'outline' | 'ghost';
  triggerSize?: 'default' | 'sm';
  iconOnly?: boolean;
}

export function RosterAddCeoDialog({
  coaches,
  defaultCoachId = null,
  triggerLabel = 'Add CEO',
  triggerVariant = 'outline',
  triggerSize = 'sm',
  iconOnly = false,
}: Props) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [coachId, setCoachId] = useState<string | null>(defaultCoachId);
  const [tenXGoal, setTenXGoal] = useState('');

  const create = trpc.admin.createCeo.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      utils.admin.listCoaches.invalidate();
      setOpen(false);
      setName('');
      setEmail('');
      setTenXGoal('');
      setCoachId(defaultCoachId);
    },
  });

  function reset() {
    setName('');
    setEmail('');
    setTenXGoal('');
    setCoachId(defaultCoachId);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!coachId || !name.trim()) return;
    create.mutate({
      name: name.trim(),
      email: email.trim() || null,
      coachId,
      tenXGoal: tenXGoal.trim() || null,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size={triggerSize} variant={triggerVariant}>
          <Plus className={iconOnly ? 'h-3.5 w-3.5' : 'mr-1.5 h-3.5 w-3.5'} />
          {!iconOnly && triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add a CEO</DialogTitle>
            <DialogDescription>
              Add a new CEO to the roster and assign them to a coach.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ceo-name">Name *</Label>
              <Input
                id="ceo-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ceo-email">Email</Label>
              <Input
                id="ceo-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
              />
              <p className="text-[11px] text-muted-foreground">
                Used to auto-match incoming Tally submissions. Add aliases later via the Inbox.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Coach *</Label>
              <Select value={coachId ?? ''} onValueChange={(v) => setCoachId(v || null)}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a coach" />
                </SelectTrigger>
                <SelectContent>
                  {coaches.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} <span className="text-muted-foreground">· {c.email}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ceo-goal">10x goal (optional)</Label>
              <Textarea
                id="ceo-goal"
                value={tenXGoal}
                onChange={(e) => setTenXGoal(e.target.value)}
                placeholder="The CEO's long-term ambition (editable later)"
                rows={3}
              />
            </div>
          </div>

          {create.error && (
            <p className="mt-3 text-sm text-destructive">{create.error.message}</p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !coachId || !name.trim()}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add CEO
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
