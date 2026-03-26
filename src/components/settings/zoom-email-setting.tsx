'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Check, Loader2, Pencil } from 'lucide-react';

interface ZoomEmailSettingProps {
  currentEmail: string | null;
}

export function ZoomEmailSetting({ currentEmail }: ZoomEmailSettingProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(!currentEmail);
  const [email, setEmail] = useState(currentEmail ?? '');

  const updateCoach = trpc.coaches.update.useMutation({
    onSuccess: () => {
      setEditing(false);
      router.refresh();
    },
  });

  function handleSave() {
    updateCoach.mutate({ zoomUserEmail: email.trim() || null });
  }

  if (!editing && currentEmail) {
    return (
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs text-muted-foreground">Zoom Email</Label>
          <p className="mt-1 text-sm font-mono">{currentEmail}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="zoom-email">Zoom Email</Label>
        <Input
          id="zoom-email"
          type="email"
          placeholder="your.zoom@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={updateCoach.isPending || !email.trim()}>
          {updateCoach.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          )}
          Save
        </Button>
        {currentEmail && (
          <Button variant="outline" size="sm" onClick={() => { setEmail(currentEmail); setEditing(false); }}>
            Cancel
          </Button>
        )}
      </div>
      {updateCoach.error && (
        <p className="text-sm text-destructive">{updateCoach.error.message}</p>
      )}
    </div>
  );
}
