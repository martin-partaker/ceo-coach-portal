'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Loader2, Check, ListChecks, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TriageCard, type TriageCardData } from './triage-card';
import { MatchToExistingButton } from './match-to-existing-button';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-background px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

interface SessionStats {
  confirmed: number;
  overridden: number;
  discarded: number;
  skipped: number;
}

export function TriageWalkthrough() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch } = trpc.inbox.triageQueue.useQuery();

  const [index, setIndex] = useState(0);
  const [actedIds, setActedIds] = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<SessionStats>({
    confirmed: 0,
    overridden: 0,
    discarded: 0,
    skipped: 0,
  });
  // Snapshotted at session start; doesn't change as items get resolved.
  // Reset by the "Reset & reload" button.
  const [totalAtStart, setTotalAtStart] = useState<number | null>(null);

  useEffect(() => {
    if (data && totalAtStart === null) {
      setTotalAtStart(data.length);
    }
  }, [data, totalAtStart]);

  // Queue: server data filtered by optimistic local-acted ids, with skipped
  // rolled to the end. Auto-resolved rows disappear naturally because the
  // server stops including them in triageQueue.
  const queue = useMemo(() => {
    if (!data) return [];
    const active = data.filter((d) => !actedIds.has(d.rawInputId));
    const head = active.filter((d) => !skippedIds.has(d.rawInputId));
    const tail = active.filter((d) => skippedIds.has(d.rawInputId));
    return [...head, ...tail];
  }, [data, actedIds, skippedIds]);

  const total = totalAtStart ?? 0;
  const remaining = queue.length;
  const done = Math.max(0, total - remaining);
  const current = queue[Math.min(index, Math.max(queue.length - 1, 0))] ?? null;

  const assignMutation = trpc.inbox.assignToCeo.useMutation();
  const assignCycleMutation = trpc.inbox.assignCycle.useMutation();
  const discardMutation = trpc.inbox.discard.useMutation();

  const back = useCallback(() => {
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  const markActed = useCallback((id: string) => {
    setActedIds((s) => new Set([...s, id]));
    setSkippedIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    // Don't increment index — `queue` is filtered by actedIds, so removing the
    // current item naturally shifts queue[index] to what was queue[index+1].
  }, []);

  const onConfirm = useCallback(async () => {
    if (!current?.topSuggestion) return;
    const id = current.rawInputId;
    setStats((s) => ({ ...s, confirmed: s.confirmed + 1 }));
    markActed(id);
    try {
      // pending_cycle: CEO already matched; we just need a cycle assignment.
      if (
        current.matchStatus === 'pending_cycle' &&
        current.cycleSuggestion?.cycleId
      ) {
        await assignCycleMutation.mutateAsync({
          rawInputId: id,
          cycleId: current.cycleSuggestion.cycleId,
        });
      } else {
        // pending_ceo (or pending_cycle without a cycle suggestion — treat as
        // a CEO assignment fallback).
        await assignMutation.mutateAsync({
          rawInputId: id,
          ceoId: current.topSuggestion.ceoId,
          addAliasFromSubmission: !!current.submitterEmail,
        });
      }
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    } catch (err) {
      console.error('confirm failed', err);
    }
  }, [current, markActed, assignMutation, assignCycleMutation, utils]);

  const onDiscard = useCallback(async () => {
    if (!current) return;
    const id = current.rawInputId;
    setStats((s) => ({ ...s, discarded: s.discarded + 1 }));
    markActed(id);
    try {
      await discardMutation.mutateAsync({ rawInputId: id, reason: 'admin_triaged' });
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    } catch (err) {
      console.error('discard failed', err);
    }
  }, [current, markActed, discardMutation, utils]);

  const onSkip = useCallback(() => {
    if (!current) return;
    setStats((s) => ({ ...s, skipped: s.skipped + 1 }));
    setSkippedIds((s) => new Set([...s, current.rawInputId]));
    // For skip we DO advance — the item stays in the queue (rolled to end).
    setIndex((i) => Math.min(i + 1, Math.max(queue.length - 1, 0)));
  }, [current, queue.length]);

  // External resolution (e.g. via the Match dialog) — update local state to
  // remove the row from the queue and refresh data.
  const onExternalMatch = useCallback(() => {
    if (!current) return;
    setStats((s) => ({ ...s, overridden: s.overridden + 1 }));
    markActed(current.rawInputId);
    utils.inbox.pendingCounts.invalidate();
    utils.inbox.triageQueue.invalidate();
  }, [current, markActed, utils]);

  // Confidence-graded confirm: amber tier requires hold-to-confirm.
  const confidenceTier: 'high' | 'medium' | 'low' = (() => {
    const c = current?.topSuggestion?.confidence ?? 0;
    if (c >= 95) return 'high';
    if (c >= 70) return 'medium';
    return 'low';
  })();
  const confirmDisabled = !current?.topSuggestion || confidenceTier === 'low';

  // Keyboard handlers
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      // Don't fire while typing in inputs / dialogs
      const target = e.target as HTMLElement;
      if (target?.closest('input, textarea, [contenteditable=true], [role=dialog]')) return;

      if (e.key === 'Enter' && !confirmDisabled) {
        e.preventDefault();
        onConfirm();
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        onDiscard();
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSkip();
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, confirmDisabled, onConfirm, onDiscard, onSkip, back]);

  // ── Render ──
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border">
        <Check className="h-8 w-8 text-emerald-500" />
        <p className="text-sm font-medium">All caught up</p>
        <p className="text-xs text-muted-foreground">No pending submissions to triage.</p>
      </div>
    );
  }

  if (queue.length === 0 || !current) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <ListChecks className="mx-auto h-8 w-8 text-emerald-500" />
          <p className="mt-3 text-sm font-medium">Session complete</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Reviewed {total} ·{' '}
            <span className="text-foreground">{stats.confirmed}</span> confirmed ·{' '}
            <span className="text-foreground">{stats.overridden}</span> overridden ·{' '}
            <span className="text-foreground">{stats.discarded}</span> discarded ·{' '}
            <span className="text-foreground">{stats.skipped}</span> skipped
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setActedIds(new Set());
                setSkippedIds(new Set());
                setStats({ confirmed: 0, overridden: 0, discarded: 0, skipped: 0 });
                setIndex(0);
                setTotalAtStart(null);
                refetch();
              }}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset & reload
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Cast to view shape (server timestamps are stringified by superjson)
  const cardData: TriageCardData = current as unknown as TriageCardData;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Progress strip */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">Walkthrough</span>
          <span>· One-by-one verification</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono tabular-nums">
            <span className="text-foreground">{done}</span> / {total}
          </span>
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground transition-all"
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* The card */}
      <TriageCard data={cardData} />

      {/* Action bar */}
      <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={
              confirmDisabled ||
              assignMutation.isPending ||
              assignCycleMutation.isPending ||
              (current.matchStatus === 'pending_cycle' && !current.cycleSuggestion)
            }
            className={cn(
              confidenceTier === 'high' && 'bg-emerald-600 hover:bg-emerald-700',
              confidenceTier === 'medium' && 'bg-foreground'
            )}
          >
            {current.matchStatus === 'pending_cycle' && current.cycleSuggestion
              ? `Confirm cycle → ${current.cycleSuggestion.cycleLabel}`
              : current.topSuggestion
                ? `Confirm → ${current.topSuggestion.ceoName}`
                : 'Confirm'}
            <Kbd>↵</Kbd>
          </Button>
          <MatchToExistingButton
            rawInputId={current.rawInputId}
            submissionEmail={current.submitterEmail}
            onMatched={onExternalMatch}
          />
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            Discard
            <Kbd>D</Kbd>
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Button size="sm" variant="ghost" onClick={onSkip}>
            Skip
            <Kbd>S</Kbd>
          </Button>
          <Button size="sm" variant="ghost" onClick={back} disabled={index === 0}>
            Back
            <Kbd>B</Kbd>
          </Button>
        </div>
      </div>

      {/* Hint when low confidence: confirm is disabled */}
      {confidenceTier === 'low' && current.topSuggestion && (
        <p className="text-center text-xs text-muted-foreground">
          Low-confidence match — Enter is disabled. Use{' '}
          <Kbd>Tab</Kbd> to pick a CEO yourself.
        </p>
      )}

    </div>
  );
}
