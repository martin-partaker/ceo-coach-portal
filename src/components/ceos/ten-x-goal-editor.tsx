'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Check, Loader2, Pencil } from 'lucide-react';

interface TenXGoalEditorProps {
  ceoId: string;
  initialGoal: string | null;
  updatedAt: Date | null;
}

export function TenXGoalEditor({ ceoId, initialGoal, updatedAt }: TenXGoalEditorProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(initialGoal ?? '');

  const updateCeo = trpc.ceos.update.useMutation({
    onSuccess: () => {
      setEditing(false);
      router.refresh();
    },
  });

  function handleSave() {
    updateCeo.mutate({ id: ceoId, tenXGoal: goal || null });
  }

  if (!editing) {
    return (
      <div>
        {initialGoal ? (
          <div>
            <p className="text-sm whitespace-pre-wrap">{initialGoal}</p>
            {updatedAt && (
              <p className="mt-2 text-xs text-muted-foreground">
                Last updated {new Date(updatedAt).toLocaleDateString()}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No 10x goal set yet.</p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setEditing(true)}
        >
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          {initialGoal ? 'Edit' : 'Set goal'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="What is their 10x goal? E.g., 'Take the company from $10M to $100M ARR in 3 years'"
        rows={4}
        autoFocus
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={updateCeo.isPending}>
          {updateCeo.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          )}
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setGoal(initialGoal ?? '');
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
