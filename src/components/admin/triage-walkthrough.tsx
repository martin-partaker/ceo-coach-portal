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

  // The active queue is the original list minus rows already acted on.
  // Skipped rows roll back to the end.
  const queue = useMemo(() => {
    if (!data) return [];
    const active = data.filter((d) => !actedIds.has(d.rawInputId));
    const head = active.filter((d) => !skippedIds.has(d.rawInputId));
    const tail = active.filter((d) => skippedIds.has(d.rawInputId));
    return [...head, ...tail];
  }, [data, actedIds, skippedIds]);

  const total = data?.length ?? 0;
  const done = actedIds.size;
  const current = queue[Math.min(index, Math.max(queue.length - 1, 0))] ?? null;

  const assignMutation = trpc.inbox.assignToCeo.useMutation();
  const discardMutation = trpc.inbox.discard.useMutation();

  const advance = useCallback(() => {
    setIndex((i) => Math.min(i + 1, Math.max(queue.length - 1, 0)));
  }, [queue.length]);

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
  }, []);

  const onConfirm = useCallback(async () => {
    if (!current?.topSuggestion) return;
    const id = current.rawInputId;
    const ceoId = current.topSuggestion.ceoId;
    setStats((s) => ({ ...s, confirmed: s.confirmed + 1 }));
    markActed(id);
    advance();
    try {
      await assignMutation.mutateAsync({
        rawInputId: id,
        ceoId,
        addAliasFromSubmission: !!current.submitterEmail,
      });
      utils.inbox.pendingCounts.invalidate();
    } catch (err) {
      console.error('confirm failed', err);
    }
  }, [current, advance, markActed, assignMutation, utils]);

  const onDiscard = useCallback(async () => {
    if (!current) return;
    const id = current.rawInputId;
    setStats((s) => ({ ...s, discarded: s.discarded + 1 }));
    markActed(id);
    advance();
    try {
      await discardMutation.mutateAsync({ rawInputId: id, reason: 'admin_triaged' });
      utils.inbox.pendingCounts.invalidate();
    } catch (err) {
      console.error('discard failed', err);
    }
  }, [current, advance, markActed, discardMutation, utils]);

  const onSkip = useCallback(() => {
    if (!current) return;
    setStats((s) => ({ ...s, skipped: s.skipped + 1 }));
    setSkippedIds((s) => new Set([...s, current.rawInputId]));
    advance();
  }, [current, advance]);

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
            disabled={confirmDisabled || assignMutation.isPending}
            className={cn(
              confidenceTier === 'high' && 'bg-emerald-600 hover:bg-emerald-700',
              confidenceTier === 'medium' && 'bg-foreground'
            )}
          >
            Confirm{current.topSuggestion ? ` → ${current.topSuggestion.ceoName}` : ''}
            <Kbd>↵</Kbd>
          </Button>
          <MatchToExistingButton
            rawInputId={current.rawInputId}
            submissionEmail={current.submitterEmail}
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
