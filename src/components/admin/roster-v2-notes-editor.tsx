'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  cycleId: string;
  initialValue: string | null;
}

const SAVE_DEBOUNCE_MS = 800;

/**
 * Debounced autosave textarea for cycle.additionalContext. Mirrors the
 * "Extra Notes & Context" slot in the inline workspace.
 */
export function NotesEditor({ cycleId, initialValue }: Props) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(initialValue ?? '');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSavedRef = useRef<string>(initialValue ?? '');

  const update = trpc.roster.updateCycle.useMutation({
    onSuccess: () => {
      lastSavedRef.current = value;
      setSavedAt(Date.now());
      setError(null);
      utils.roster.cycleDetail.invalidate({ cycleId });
    },
    onError: (e) => setError(e.message),
  });

  // Reset when cycle switches
  useEffect(() => {
    setValue(initialValue ?? '');
    lastSavedRef.current = initialValue ?? '';
    setSavedAt(null);
    setError(null);
  }, [cycleId, initialValue]);

  // Debounced save
  useEffect(() => {
    if (value === lastSavedRef.current) return;
    const t = setTimeout(() => {
      update.mutate({ cycleId, additionalContext: value || null });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, cycleId]);

  const dirty = value !== lastSavedRef.current;
  const showSaved = savedAt && Date.now() - savedAt < 4000 && !dirty;

  return (
    <div className="space-y-1">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste any additional context — emails, notes, meeting prep — that should inform this session."
        rows={3}
        className="text-[12px] leading-relaxed"
      />
      <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground">
        <span>{value.length} char{value.length === 1 ? '' : 's'}</span>
        <span className={cn('inline-flex items-center gap-1', error && 'text-destructive')}>
          {update.isPending && (
            <>
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> saving…
            </>
          )}
          {!update.isPending && dirty && <span>unsaved</span>}
          {!update.isPending && !dirty && showSaved && (
            <>
              <Check className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" /> saved
            </>
          )}
          {error && <span>{error}</span>}
        </span>
      </div>
    </div>
  );
}
