'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2,
  Circle,
  Ban,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Owner = 'CEO' | 'Coach' | 'Other';
type Status = 'open' | 'done' | 'dropped';

const OWNERS: Owner[] = ['CEO', 'Coach', 'Other'];

export interface ActionItemRow {
  id: string;
  cycleId: string;
  owner: string;
  item: string;
  dueAt: string | null;
  status: string;
  aiSuggested: boolean;
  reviewed: boolean;
  /** Server-provided creation timestamp; we sort on this so the order
   *  is locked regardless of edits or status changes. */
  createdAt: Date | string;
}

interface Props {
  cycleId: string;
  items: ActionItemRow[];
  reviewedCount: number;
}

/**
 * Editable action items list. Designed for two clean visual axes:
 *  - Status (open / done / dropped) → the icon on the left.
 *  - Reviewed-ness → a thin amber left-border on un-reviewed AI items;
 *    every other row is calm and white. The bulk "Mark all reviewed"
 *    button is the gate-pass shortcut.
 *
 * Provenance (AI vs manual) is permanent — the AI badge stays whether
 * or not the coach has reviewed the row, because it's a fact about
 * the item, not a state.
 *
 * All edits are optimistic via React Query's onMutate; the server
 * round-trip is invisible. Order is locked to ascending createdAt
 * client-side so status changes never shuffle the list.
 */
export function ActionItemsEditableList({ cycleId, items, reviewedCount }: Props) {
  const utils = trpc.useUtils();

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const at = new Date(a.createdAt).getTime();
      const bt = new Date(b.createdAt).getTime();
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
  }, [items]);

  const total = sorted.length;
  const isEmpty = total === 0;
  const allReviewed = !isEmpty && reviewedCount === total;
  const unreviewedCount = total - reviewedCount;

  // Returning the promise from `onSuccess` keeps `mutation.isPending`
  // honest — the spinner stays until the dependent queries finish
  // refetching, so there's no visible blank gap after Suggest.
  async function invalidateAll() {
    await Promise.all([
      utils.roster.cycleDetail.invalidate({ cycleId }),
      utils.roster.cycleSummary.invalidate(),
      utils.actionItems.listForCycle.invalidate({ cycleId }),
    ]);
  }

  const setAll = trpc.actionItems.setAllReviewed.useMutation({ onSuccess: invalidateAll });
  const suggest = trpc.roster.suggestActionItems.useMutation({ onSuccess: invalidateAll });
  const create = trpc.actionItems.create.useMutation({ onSuccess: invalidateAll });

  return (
    <div className="grid gap-1.5">
      {/* Header-row actions live inline now that the outer chrome (title,
          dot, status) is provided by the wrapping InputSlot. */}
      {(unreviewedCount > 0 || true) && (
        <div className="flex items-center gap-1.5 pb-1">
          {unreviewedCount > 0 && (
            <span
              className="rounded-full px-1.5 py-px text-[10px] font-medium"
              style={{
                background: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 88%)',
                color: 'oklch(58% 0.13 64)',
              }}
            >
              {unreviewedCount} to review
            </span>
          )}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={suggest.isPending}
            onClick={() => suggest.mutate({ cycleId })}
            title="Re-extract action items from this cycle's transcripts"
          >
            {suggest.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3" />
            )}
            Suggest
          </Button>
          {!isEmpty && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={setAll.isPending}
              onClick={() => setAll.mutate({ cycleId, reviewed: !allReviewed })}
            >
              {setAll.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-3 w-3" />
              )}
              {allReviewed ? 'Unreview all' : 'Mark all reviewed'}
            </Button>
          )}
        </div>
      )}

      {suggest.error && (
        <p className="text-[11px] text-destructive">{suggest.error.message}</p>
      )}

      {isEmpty && !suggest.isPending && (
        <div className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          No action items — section auto-reviewed.
        </div>
      )}

      {sorted.map((a) => (
        <ActionItemRowEditor key={a.id} cycleId={cycleId} row={a} />
      ))}

      <AddActionItemRow
        onAdd={(payload) => create.mutate({ cycleId, ...payload })}
        isPending={create.isPending}
      />
    </div>
  );
}

function ActionItemRowEditor({
  cycleId,
  row,
}: {
  cycleId: string;
  row: ActionItemRow;
}) {
  const utils = trpc.useUtils();

  // Optimistic update: we patch the cached cycleDetail before the
  // server round-trip so the row's appearance reflects the click
  // immediately. On error we roll back; on settled we invalidate so
  // we converge on truth.
  type CycleDetail = ReturnType<
    typeof utils.roster.cycleDetail.getData
  > extends infer T
    ? T
    : never;

  const update = trpc.actionItems.update.useMutation({
    onMutate: async (variables) => {
      await utils.roster.cycleDetail.cancel({ cycleId });
      const prev = utils.roster.cycleDetail.getData({ cycleId });
      if (prev) {
        const next = {
          ...prev,
          actionItems: prev.actionItems.map((a) => {
            if (a.id !== variables.id) return a;
            const merged: typeof a = { ...a };
            if (variables.owner !== undefined) merged.owner = variables.owner;
            if (variables.item !== undefined) merged.item = variables.item;
            if (variables.dueAt !== undefined) merged.dueAt = variables.dueAt;
            if (variables.status !== undefined) merged.status = variables.status;
            // Touch ⇒ reviewed (server-side rule, mirrored locally so the
            // amber border disappears immediately on first interaction).
            if (variables.reviewed !== undefined) merged.reviewed = variables.reviewed;
            else if (
              variables.owner !== undefined ||
              variables.item !== undefined ||
              variables.dueAt !== undefined ||
              variables.status !== undefined
            ) {
              merged.reviewed = true;
            }
            return merged;
          }),
        };
        utils.roster.cycleDetail.setData({ cycleId }, next as CycleDetail);
      }
      return { prev };
    },
    onError: (_err, _variables, ctx) => {
      if (ctx?.prev) utils.roster.cycleDetail.setData({ cycleId }, ctx.prev as CycleDetail);
    },
    onSettled: async () => {
      await Promise.all([
        utils.roster.cycleDetail.invalidate({ cycleId }),
        utils.roster.cycleSummary.invalidate(),
      ]);
    },
  });

  const remove = trpc.actionItems.delete.useMutation({
    onMutate: async () => {
      await utils.roster.cycleDetail.cancel({ cycleId });
      const prev = utils.roster.cycleDetail.getData({ cycleId });
      if (prev) {
        const next = {
          ...prev,
          actionItems: prev.actionItems.filter((a) => a.id !== row.id),
        };
        utils.roster.cycleDetail.setData({ cycleId }, next as CycleDetail);
      }
      return { prev };
    },
    onError: (_err, _variables, ctx) => {
      if (ctx?.prev) utils.roster.cycleDetail.setData({ cycleId }, ctx.prev as CycleDetail);
    },
    onSettled: async () => {
      await Promise.all([
        utils.roster.cycleDetail.invalidate({ cycleId }),
        utils.roster.cycleSummary.invalidate(),
      ]);
    },
  });

  const [draft, setDraft] = useState(row.item);
  useEffect(() => setDraft(row.item), [row.item]);

  const status = (row.status as Status) ?? 'open';
  const owner = (row.owner as Owner) ?? 'CEO';
  const StatusIcon =
    status === 'done' ? CheckCircle2 : status === 'dropped' ? Ban : Circle;

  // Unreviewed AI items get a subtle amber left-border. Once the coach
  // touches the item (or hits Mark all reviewed), the border goes away.
  // The AI badge itself is always shown for AI items — it tells you
  // about provenance, not state.
  const needsReview = row.aiSuggested && !row.reviewed;

  function cycleStatus() {
    const next: Status = status === 'open' ? 'done' : status === 'done' ? 'dropped' : 'open';
    update.mutate({ id: row.id, status: next });
  }

  function cycleOwner() {
    const idx = OWNERS.indexOf(owner);
    const next = OWNERS[(idx + 1) % OWNERS.length];
    update.mutate({ id: row.id, owner: next });
  }

  function commitText() {
    const trimmed = draft.trim();
    if (trimmed === row.item) return;
    if (!trimmed) {
      setDraft(row.item);
      return;
    }
    update.mutate({ id: row.id, item: trimmed });
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded border bg-background px-2.5 py-1.5 text-[12px] transition-colors',
        needsReview ? 'border-amber-500/40' : 'border-border'
      )}
      style={
        needsReview
          ? { boxShadow: 'inset 3px 0 0 0 oklch(70% 0.15 64)' }
          : undefined
      }
    >
      <button
        type="button"
        onClick={cycleStatus}
        title={`${status} — click to cycle open → done → dropped`}
        aria-label={`Cycle status from ${status}`}
        className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
      >
        <StatusIcon
          className={cn(
            'h-4 w-4',
            status === 'done' && 'text-emerald-600 dark:text-emerald-400',
            status === 'dropped' && 'text-muted-foreground/50'
          )}
        />
      </button>

      <button
        type="button"
        onClick={cycleOwner}
        title="Click to cycle CEO → Coach → Other"
        className={cn(
          'inline-flex shrink-0 items-center rounded border px-1.5 py-px font-mono text-[10px] transition-colors',
          owner === 'CEO' && 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
          owner === 'Coach' && 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400',
          owner === 'Other' && 'border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-400'
        )}
      >
        {owner}
      </button>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget as HTMLTextAreaElement).blur();
          }
        }}
        rows={1}
        className={cn(
          'min-w-0 flex-1 resize-none border-0 bg-transparent text-[12px] leading-snug outline-none focus:ring-0',
          status === 'done' && 'text-foreground/60',
          status === 'dropped' && 'text-foreground/50 line-through'
        )}
      />

      <input
        type="date"
        value={row.dueAt ?? ''}
        onChange={(e) =>
          update.mutate({ id: row.id, dueAt: e.target.value || null })
        }
        className="mt-0.5 w-[110px] shrink-0 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-border focus:border-border focus:outline-none"
        title={row.dueAt ? `Due ${row.dueAt}` : 'No due date'}
      />

      {row.aiSuggested && (
        <span
          className={cn(
            'mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium transition-opacity',
            row.reviewed && 'opacity-50'
          )}
          style={{
            background: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 88%)',
            color: 'oklch(58% 0.14 258)',
          }}
          title={
            row.reviewed
              ? 'This item was AI-generated (already reviewed).'
              : 'AI-suggested — review or edit before generating the email.'
          }
        >
          <Sparkles className="h-2.5 w-2.5" /> AI
        </span>
      )}

      <button
        type="button"
        onClick={() => remove.mutate({ id: row.id })}
        title="Delete action item"
        aria-label="Delete action item"
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function AddActionItemRow({
  onAdd,
  isPending,
}: {
  onAdd: (payload: { owner: Owner; item: string; dueAt: string | null }) => void;
  isPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [owner, setOwner] = useState<Owner>('CEO');
  const [dueAt, setDueAt] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function reset() {
    setText('');
    setDueAt('');
    setOwner('CEO');
    setOpen(false);
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return reset();
    onAdd({ owner, item: trimmed, dueAt: dueAt || null });
    reset();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded border border-dashed border-border bg-background px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> Add action item
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded border border-border bg-background px-2.5 py-1.5 text-[12px]">
      <button
        type="button"
        onClick={() =>
          setOwner(OWNERS[(OWNERS.indexOf(owner) + 1) % OWNERS.length])
        }
        className={cn(
          'inline-flex shrink-0 items-center rounded border px-1.5 py-px font-mono text-[10px]',
          owner === 'CEO' && 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
          owner === 'Coach' && 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400',
          owner === 'Other' && 'border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-400'
        )}
      >
        {owner}
      </button>

      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') reset();
        }}
        placeholder="What did the CEO commit to?"
        className="min-w-0 flex-1 border-0 bg-transparent text-[12px] outline-none focus:ring-0"
      />

      <input
        type="date"
        value={dueAt}
        onChange={(e) => setDueAt(e.target.value)}
        className="w-[110px] shrink-0 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-border focus:border-border focus:outline-none"
      />

      <Button
        size="sm"
        className="h-6 px-2 text-[11px]"
        onClick={submit}
        disabled={isPending || !text.trim()}
      >
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
      </Button>
      <button
        type="button"
        onClick={reset}
        title="Cancel"
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
