'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Check, ListChecks, RotateCcw, Trash2, Undo2 } from 'lucide-react';
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

type Action = 'confirmed' | 'overridden' | 'discarded' | 'skipped';

interface HistoryEntry {
  rawInputId: string;
  action: Action;
  // Snapshot of the row's pre-action state for restore on undo
  prevState: {
    matchStatus: string;
    ceoId: string | null;
    cycleId: string | null;
    coachId: string | null;
    matchConfidence: number | null;
    matchCandidates: unknown;
  };
}

export function TriageWalkthrough() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch } = trpc.inbox.triageQueue.useQuery();

  const [actedIds, setActedIds] = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<SessionStats>({
    confirmed: 0,
    overridden: 0,
    discarded: 0,
    skipped: 0,
  });
  const [totalAtStart, setTotalAtStart] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0); // 0 = current item, 1 = last actioned, ...
  const [discardOpen, setDiscardOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);

  // Cache every card data we've seen so Back can render historical items even
  // after they leave the live `data` (because they got resolved server-side).
  const cardCache = useRef<Map<string, TriageCardData>>(new Map());
  if (data) {
    for (const d of data) {
      cardCache.current.set(d.rawInputId, d as unknown as TriageCardData);
    }
  }

  useEffect(() => {
    if (data && totalAtStart === null) {
      setTotalAtStart(data.length);
    }
  }, [data, totalAtStart]);

  // Forward queue: rows from `data` not yet acted on, with skipped at the end.
  const forwardQueue = useMemo(() => {
    if (!data) return [];
    const active = data.filter((d) => !actedIds.has(d.rawInputId));
    const head = active.filter((d) => !skippedIds.has(d.rawInputId));
    const tail = active.filter((d) => skippedIds.has(d.rawInputId));
    return [...head, ...tail];
  }, [data, actedIds, skippedIds]);

  // Resolve "current": when historyOffset > 0 we're viewing a previous item.
  const inHistoryView = historyOffset > 0;
  const historyEntry = inHistoryView
    ? history[history.length - historyOffset]
    : null;
  const currentLive = forwardQueue[0] ?? null;
  const currentCardData: TriageCardData | null = inHistoryView && historyEntry
    ? cardCache.current.get(historyEntry.rawInputId) ?? null
    : currentLive ?? null;

  const total = totalAtStart ?? 0;
  // Position = number of items the user has moved past (acted + skipped).
  const position = actedIds.size + skippedIds.size;
  const displayPosition = Math.max(0, position - historyOffset);

  const assignMutation = trpc.inbox.assignToCeo.useMutation();
  const assignCycleMutation = trpc.inbox.assignCycle.useMutation();
  const discardMutation = trpc.inbox.discard.useMutation();
  const restoreMutation = trpc.inbox.restore.useMutation();

  const recordAction = useCallback(
    (entry: HistoryEntry) => {
      setHistory((h) => [...h, entry]);
    },
    []
  );

  const markActed = useCallback((id: string) => {
    setActedIds((s) => new Set([...s, id]));
    setSkippedIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

  const snapshotPrev = (d: TriageCardData) => ({
    matchStatus: d.matchStatus,
    ceoId: null as string | null, // We don't have the original IDs in card data; server uses these to revert
    cycleId: null as string | null,
    coachId: null as string | null,
    matchConfidence: null as number | null,
    matchCandidates: null,
  });

  const onConfirm = useCallback(async () => {
    if (inHistoryView) return; // Don't confirm while viewing history
    if (!currentCardData?.topSuggestion) return;
    const id = currentCardData.rawInputId;
    setStats((s) => ({ ...s, confirmed: s.confirmed + 1 }));
    markActed(id);
    recordAction({ rawInputId: id, action: 'confirmed', prevState: snapshotPrev(currentCardData) });
    try {
      if (
        currentCardData.matchStatus === 'pending_cycle' &&
        currentCardData.cycleSuggestion?.cycleId
      ) {
        await assignCycleMutation.mutateAsync({
          rawInputId: id,
          cycleId: currentCardData.cycleSuggestion.cycleId,
        });
      } else {
        await assignMutation.mutateAsync({
          rawInputId: id,
          ceoId: currentCardData.topSuggestion.ceoId,
          addAliasFromSubmission: !!currentCardData.submitterEmail,
        });
      }
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    } catch (err) {
      console.error('confirm failed', err);
    }
  }, [
    inHistoryView,
    currentCardData,
    markActed,
    recordAction,
    assignMutation,
    assignCycleMutation,
    utils,
  ]);

  const onPickAlternative = useCallback(
    async (ceoId: string) => {
      if (inHistoryView || !currentCardData) return;
      const id = currentCardData.rawInputId;
      setStats((s) => ({ ...s, overridden: s.overridden + 1 }));
      markActed(id);
      recordAction({
        rawInputId: id,
        action: 'overridden',
        prevState: snapshotPrev(currentCardData),
      });
      try {
        await assignMutation.mutateAsync({
          rawInputId: id,
          ceoId,
          addAliasFromSubmission: !!currentCardData.submitterEmail,
        });
        utils.inbox.pendingCounts.invalidate();
        utils.inbox.triageQueue.invalidate();
      } catch (err) {
        console.error('pick alternative failed', err);
      }
    },
    [inHistoryView, currentCardData, markActed, recordAction, assignMutation, utils]
  );

  const onDiscard = useCallback(async () => {
    if (inHistoryView || !currentCardData) return;
    setDiscardOpen(false);
    const id = currentCardData.rawInputId;
    setStats((s) => ({ ...s, discarded: s.discarded + 1 }));
    markActed(id);
    recordAction({ rawInputId: id, action: 'discarded', prevState: snapshotPrev(currentCardData) });
    try {
      await discardMutation.mutateAsync({ rawInputId: id, reason: 'admin_triaged' });
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    } catch (err) {
      console.error('discard failed', err);
    }
  }, [inHistoryView, currentCardData, markActed, recordAction, discardMutation, utils]);

  const onSkip = useCallback(() => {
    if (inHistoryView || !currentCardData) return;
    const id = currentCardData.rawInputId;
    setStats((s) => ({ ...s, skipped: s.skipped + 1 }));
    setSkippedIds((s) => new Set([...s, id]));
    recordAction({ rawInputId: id, action: 'skipped', prevState: snapshotPrev(currentCardData) });
  }, [inHistoryView, currentCardData, recordAction]);

  const onBack = useCallback(() => {
    if (history.length === 0) return;
    setHistoryOffset((o) => Math.min(o + 1, history.length));
  }, [history.length]);

  const onForward = useCallback(() => {
    setHistoryOffset((o) => Math.max(0, o - 1));
  }, []);

  const onUndo = useCallback(async () => {
    if (!historyEntry) return;
    const { rawInputId, action, prevState } = historyEntry;

    // Local state revert
    setActedIds((s) => {
      const n = new Set(s);
      n.delete(rawInputId);
      return n;
    });
    setSkippedIds((s) => {
      const n = new Set(s);
      n.delete(rawInputId);
      return n;
    });
    setStats((s) => ({
      ...s,
      confirmed: s.confirmed - (action === 'confirmed' ? 1 : 0),
      overridden: s.overridden - (action === 'overridden' ? 1 : 0),
      discarded: s.discarded - (action === 'discarded' ? 1 : 0),
      skipped: s.skipped - (action === 'skipped' ? 1 : 0),
    }));
    setHistory((h) => h.filter((e) => e.rawInputId !== rawInputId));
    setHistoryOffset(0);

    // Server revert (skips don't need a server call — they were never persisted)
    if (action !== 'skipped') {
      try {
        await restoreMutation.mutateAsync({
          rawInputId,
          matchStatus: (prevState.matchStatus as
            | 'matched'
            | 'pending_ceo'
            | 'pending_cycle'
            | 'pending_classification'
            | 'discarded') ?? 'pending_ceo',
          ceoId: prevState.ceoId,
          cycleId: prevState.cycleId,
          coachId: prevState.coachId,
          matchConfidence: prevState.matchConfidence,
          matchCandidates: prevState.matchCandidates,
        });
        utils.inbox.pendingCounts.invalidate();
        utils.inbox.triageQueue.invalidate();
      } catch (err) {
        console.error('undo failed', err);
      }
    }
  }, [historyEntry, restoreMutation, utils]);

  // Confidence tier on the live current
  const liveTopConfidence = currentLive?.topSuggestion?.confidence ?? 0;
  const confidenceTier: 'high' | 'medium' | 'low' =
    liveTopConfidence >= 95 ? 'high' : liveTopConfidence >= 70 ? 'medium' : 'low';
  const confirmDisabled = inHistoryView || !currentLive?.topSuggestion || confidenceTier === 'low';

  // Keyboard
  useEffect(() => {
    if (!currentCardData) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest('input, textarea, [contenteditable=true], [role=dialog]')) return;
      if (e.key === 'Enter' && !confirmDisabled) {
        e.preventDefault();
        onConfirm();
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (!inHistoryView) setDiscardOpen(true);
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSkip();
      } else if (e.key === 'Tab' && !inHistoryView && currentLive) {
        e.preventDefault();
        setMatchOpen(true);
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        onBack();
      } else if (e.key.toLowerCase() === 'u' && inHistoryView) {
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentCardData, confirmDisabled, inHistoryView, onConfirm, onSkip, onBack, onUndo]);

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

  if (forwardQueue.length === 0 && !inHistoryView) {
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
                setHistory([]);
                setHistoryOffset(0);
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

  if (!currentCardData) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Progress strip */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-medium text-foreground">Walkthrough</span>
          <span>· One-by-one verification</span>
          {skippedIds.size > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
              {skippedIds.size} skipped — will roll back at the end
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono tabular-nums">
            <span className="text-foreground">{displayPosition}</span> / {total}
          </span>
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground transition-all"
              style={{ width: total ? `${(displayPosition / total) * 100}%` : '0%' }}
            />
          </div>
        </div>
      </div>

      {/* History banner — shown when navigating back to an actioned item */}
      {inHistoryView && historyEntry && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-2 text-xs">
          <div>
            <span className="font-medium">Reviewing previous · </span>
            <span className="text-muted-foreground">
              You {historyEntry.action} this submission ·{' '}
              {historyOffset} step{historyOffset === 1 ? '' : 's'} back
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onUndo} disabled={restoreMutation.isPending}>
              <Undo2 className="mr-1 h-3.5 w-3.5" /> Undo
              <Kbd>U</Kbd>
            </Button>
            <Button size="sm" variant="ghost" onClick={onForward}>
              Forward
            </Button>
          </div>
        </div>
      )}

      <TriageCard
        data={currentCardData}
        onPickAlternative={inHistoryView ? undefined : onPickAlternative}
        onPickCeoClick={inHistoryView ? undefined : () => setMatchOpen(true)}
      />

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
              (currentLive?.matchStatus === 'pending_cycle' && !currentLive.cycleSuggestion)
            }
            className={cn(
              confidenceTier === 'high' && 'bg-emerald-600 hover:bg-emerald-700',
              confidenceTier === 'medium' && 'bg-foreground'
            )}
          >
            {currentLive?.matchStatus === 'pending_cycle' && currentLive.cycleSuggestion
              ? `Confirm cycle → ${currentLive.cycleSuggestion.cycleLabel}`
              : currentLive?.topSuggestion
                ? `Confirm → ${currentLive.topSuggestion.ceoName}`
                : 'Confirm'}
            <Kbd>↵</Kbd>
          </Button>
          {!inHistoryView && currentLive && (
            <MatchToExistingButton
              rawInputId={currentLive.rawInputId}
              submissionEmail={currentLive.submitterEmail}
              open={matchOpen}
              onOpenChange={setMatchOpen}
              onMatched={() => {
                setStats((s) => ({ ...s, overridden: s.overridden + 1 }));
                markActed(currentLive.rawInputId);
                recordAction({
                  rawInputId: currentLive.rawInputId,
                  action: 'overridden',
                  prevState: snapshotPrev(currentLive as TriageCardData),
                });
              }}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDiscardOpen(true)}
            disabled={inHistoryView}
            aria-label="Discard"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            <Kbd>D</Kbd>
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Button size="sm" variant="ghost" onClick={onSkip} disabled={inHistoryView}>
            Skip
            <Kbd>S</Kbd>
          </Button>
          <Button size="sm" variant="ghost" onClick={onBack} disabled={history.length === 0}>
            Back
            <Kbd>B</Kbd>
          </Button>
        </div>
      </div>

      {confidenceTier === 'low' && currentLive?.topSuggestion && !inHistoryView && (
        <p className="text-center text-xs text-muted-foreground">
          Low-confidence match — Enter is disabled. Use{' '}
          <Kbd>Tab</Kbd> to pick a CEO yourself.
        </p>
      )}

      {/* Discard confirm dialog */}
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard this submission?</DialogTitle>
            <DialogDescription>
              The row will be marked as not-coaching and removed from the triage queue. You
              can find it in the Inbox under <span className="font-medium">Discarded</span> if
              you change your mind.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onDiscard}
              disabled={discardMutation.isPending}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
