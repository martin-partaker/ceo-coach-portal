'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, Loader2, Pencil } from 'lucide-react';

interface ZoomEmailAdminProps {
  coachId: string;
  currentEmail: string | null;
}

export function ZoomEmailAdmin({ coachId, currentEmail }: ZoomEmailAdminProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(currentEmail ?? '');

  const update = trpc.admin.updateCoachZoomEmail.useMutation({
    onSuccess: () => {
      setEditing(false);
      router.refresh();
    },
  });

  if (!editing) {
    return (
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs">{currentEmail ?? 'Not set'}</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(true)}>
          <Pencil className="mr-1 h-3 w-3" />
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="zoom@email.com"
        className="h-8 text-xs"
        autoFocus
      />
      <Button
        size="sm"
        className="h-8"
        onClick={() => update.mutate({ coachId, zoomUserEmail: email.trim() || null })}
        disabled={update.isPending}
      >
        {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
      </Button>
      <Button variant="outline" size="sm" className="h-8" onClick={() => { setEmail(currentEmail ?? ''); setEditing(false); }}>
        Cancel
      </Button>
    </div>
  );
}
