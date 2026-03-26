'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Plus, Loader2 } from 'lucide-react';

export function AddCeoDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [tenXGoal, setTenXGoal] = useState('');

  const createCeo = trpc.ceos.create.useMutation({
    onSuccess: (created) => {
      setOpen(false);
      setName('');
      setEmail('');
      setTenXGoal('');
      router.push(`/ceos/${created.id}`);
      router.refresh();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createCeo.mutate({
      name,
      email: email || undefined,
      tenXGoal: tenXGoal || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Add CEO
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add a new CEO</DialogTitle>
            <DialogDescription>
              Add a coachee to your roster. You can set their 10x goal now or later.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ceo-name">Name *</Label>
              <Input
                id="ceo-name"
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ceo-email">Email</Label>
              <Input
                id="ceo-email"
                type="email"
                placeholder="ceo@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ceo-goal">10x Goal</Label>
              <Textarea
                id="ceo-goal"
                placeholder="What is their 10x goal?"
                value={tenXGoal}
                onChange={(e) => setTenXGoal(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          {createCeo.error && (
            <p className="mt-3 text-sm text-destructive">
              {createCeo.error.message}
            </p>
          )}

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createCeo.isPending || !name.trim()}>
              {createCeo.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Add CEO
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
