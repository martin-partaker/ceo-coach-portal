'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Loader2, Check, Undo2, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

type Field = 'monthlyGoals' | 'monthlyReflection';

interface Props {
  cycleId: string;
  field: Field;
  initialValue: string | null;
  ai?: boolean;
  rows?: number;
  /** Placeholder shown when the field is empty. Defaults to a generic
   *  hint; callers pass field-specific copy that nudges the operator
   *  to either type or hit Re-generate. */
  placeholder?: string;
}

const SAVE_DEBOUNCE_MS = 800;

/**
 * Inline debounced editor for a free-text cycle field with AI re-generate
 * and per-session Undo. Used for the Monthly Goals & Commitments and
 * Monthly Reflection slots — both AI-prefilled but human-editable.
 *
 * Editing the textarea autosaves and clears the server-side AI-suggested
 * flag. Re-generate calls Anthropic; Undo restores the snapshot taken
 * before that call (only available within the current session).
 */
export function CycleFieldEditor({
  cycleId,
  field,
  initialValue,
  ai,
  rows = 6,
  placeholder,
}: Props) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(initialValue ?? '');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSavedRef = useRef<string>(initialValue ?? '');
  // Snapshot of the last value the user replaced via Re-generate. Cleared
  // on Undo and on cycle switch — i.e. there's no Undo across reloads.
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const update = trpc.roster.updateCycle.useMutation({
    onSuccess: () => {
      lastSavedRef.current = value;
      setSavedAt(Date.now());
      setError(null);
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const prefill = trpc.roster.prefillCycleField.useMutation({
    onSuccess: (data) => {
      setSnapshot(data.previousValue ?? '');
      setValue(data.value);
      lastSavedRef.current = data.value;
      setSavedAt(Date.now());
      setError(null);
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  // Reset when cycle (or backing value) changes.
  useEffect(() => {
    setValue(initialValue ?? '');
    lastSavedRef.current = initialValue ?? '';
    setSavedAt(null);
    setError(null);
    setSnapshot(null);
  }, [cycleId, initialValue]);

  // Debounced autosave — only fires for human edits, not for the value
  // changes triggered by prefill (those sync lastSavedRef immediately).
  useEffect(() => {
    if (value === lastSavedRef.current) return;
    const t = setTimeout(() => {
      update.mutate({ cycleId, [field]: value || null });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, cycleId, field]);

  const dirty = value !== lastSavedRef.current;
  const showSaved = savedAt && Date.now() - savedAt < 4000 && !dirty;
  const canUndo = snapshot !== null;
  const busy = update.isPending || prefill.isPending;

  function handleUndo() {
    if (snapshot === null) return;
    const restored = snapshot;
    setSnapshot(null);
    setValue(restored);
    update.mutate({ cycleId, [field]: restored || null });
  }

  return (
    <div className="space-y-1.5">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={rows}
        disabled={busy}
        placeholder={placeholder}
        className={cn(
          'whitespace-pre-wrap text-[12px] leading-relaxed',
          ai &&
            'border-[color:color-mix(in_oklab,oklch(58%_0.14_258),transparent_75%)] bg-[color:color-mix(in_oklab,oklch(58%_0.14_258),transparent_95%)]'
        )}
      />
      <div className="flex flex-wrap items-center gap-2 px-1 text-[10px] text-muted-foreground">
        <span>
          {value.length} char{value.length === 1 ? '' : 's'}
        </span>
        <span className={cn('inline-flex items-center gap-1', error && 'text-destructive')}>
          {update.isPending && (
            <>
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> saving…
            </>
          )}
          {prefill.isPending && (
            <>
              <Sparkles className="h-2.5 w-2.5 animate-pulse" /> generating…
            </>
          )}
          {!busy && dirty && <span>unsaved</span>}
          {!busy && !dirty && showSaved && (
            <>
              <Check className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" /> saved
            </>
          )}
          {error && <span>{error}</span>}
        </span>
        <span className="flex-1" />
        {canUndo && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleUndo}
            disabled={busy}
            className="h-6 px-2 text-[11px]"
          >
            <Undo2 className="mr-1 h-3 w-3" /> Undo
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => prefill.mutate({ cycleId, field })}
          disabled={busy}
          className="h-6 px-2 text-[11px]"
        >
          <RefreshCw className={cn('mr-1 h-3 w-3', prefill.isPending && 'animate-spin')} />
          Re-generate
        </Button>
      </div>
    </div>
  );
}
