'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, Loader2, Pencil, X } from 'lucide-react';

/**
 * Inline-editable display name field used on the Settings page. Shows the
 * current name as plain text with a small pencil affordance; clicking
 * pencil swaps it for a text input + save/cancel. Persists via
 * coaches.update; on success, react-query's coaches.getMe is invalidated
 * so the topbar / sidebar pick up the new name.
 */
export function EditableNameField({ initialName }: { initialName: string }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialName);
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const update = trpc.coaches.update.useMutation({
    onSuccess: (row) => {
      setName(row.name);
      setValue(row.name);
      setEditing(false);
      utils.coaches.getMe.invalidate();
    },
  });

  const trimmed = value.trim();
  const dirty = trimmed !== name;
  const canSave = !!trimmed && dirty && !update.isPending;

  function save() {
    if (!canSave) return;
    update.mutate({ name: trimmed });
  }

  function cancel() {
    setValue(name);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-sm">{name}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
          aria-label="Edit name"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className="h-7 w-56 text-sm"
        disabled={update.isPending}
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 text-emerald-600 hover:text-emerald-600 disabled:opacity-30"
        onClick={save}
        disabled={!canSave}
        aria-label="Save name"
      >
        {update.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Check className="h-3 w-3" />
        )}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 text-muted-foreground"
        onClick={cancel}
        disabled={update.isPending}
        aria-label="Cancel"
      >
        <X className="h-3 w-3" />
      </Button>
      {update.error && (
        <span className="text-[11px] text-destructive">{update.error.message}</span>
      )}
    </div>
  );
}
