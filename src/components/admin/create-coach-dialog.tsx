'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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

export function CreateCoachDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  const createCoach = trpc.admin.createCoach.useMutation({
    onSuccess: () => {
      setOpen(false);
      setName('');
      setEmail('');
      setIsAdmin(false);
      router.refresh();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createCoach.mutate({
      name: name.trim(),
      email: email.trim(),
      isSuperAdmin: isAdmin,
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Add Coach
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add a new coach</DialogTitle>
            <DialogDescription>
              Create a coach account. They&apos;ll be able to sign up with this email.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="coach-name">Name *</Label>
              <Input
                id="coach-name"
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="coach-email">Email *</Label>
              <Input
                id="coach-email"
                type="email"
                placeholder="coach@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="flex items-center gap-3">
              <Checkbox
                id="coach-admin"
                checked={isAdmin}
                onCheckedChange={(checked) => setIsAdmin(checked === true)}
              />
              <Label htmlFor="coach-admin" className="text-sm font-normal cursor-pointer">
                Grant super admin access
              </Label>
            </div>
          </div>

          {createCoach.error && (
            <p className="mt-3 text-sm text-destructive">
              {createCoach.error.message}
            </p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createCoach.isPending || !name.trim() || !email.trim()}>
              {createCoach.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Coach
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
