'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Friendly "X seconds ago" / "5 minutes ago" / "Apr 28, 14:32" formatter. */
function formatRelative(when: Date | null): string {
  if (!when) return 'never';
  const ms = Date.now() - when.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return when.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SyncResult {
  discovered: number;
  newForms: number;
  activeForms: number;
  ingested: number;
  matched: number;
  pendingCeo: number;
  pendingCycle: number;
  duplicates: number;
  discarded: number;
  errors: Array<{ formId: string; phase: string; message: string }>;
}

/**
 * Manual "pull what might be missing" button + last-sync indicator. Calls
 * `inbox.syncTally` which mirrors the Tally crons (discover new forms +
 * pull new submissions for every active form). On success, surfaces a
 * one-line summary so the operator can see whether anything actually
 * changed; errors are collected and rendered without failing the run.
 */
export function TallySyncButton() {
  const utils = trpc.useUtils();
  const lastSync = trpc.inbox.lastTallySync.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const [result, setResult] = useState<SyncResult | null>(null);

  const sync = trpc.inbox.syncTally.useMutation({
    onSuccess: (data) => {
      setResult(data);
      utils.inbox.listDiscoveredForms.invalidate();
      utils.inbox.lastTallySync.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    },
  });

  const lastSuccess = lastSync.data?.lastSuccessAt ?? null;
  const cronErrors = lastSync.data?.errors ?? [];
  const busy = sync.isPending;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 text-[11px] tabular-nums',
            cronErrors.length > 0
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground',
          )}
        >
          <Clock className="h-3 w-3" />
          Last sync: {formatRelative(lastSuccess)}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => sync.mutate()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {busy ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>

      {result && !sync.isPending && <SyncSummary result={result} />}

      {sync.error && (
        <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
          <AlertTriangle className="h-3 w-3" />
          {sync.error.message}
        </span>
      )}
    </div>
  );
}

function SyncSummary({ result }: { result: SyncResult }) {
  // "Genuinely new" = submissions that actually landed somewhere in our
  // schema. We deliberately exclude `duplicates` (already in raw_inputs
  // — Tally's API doesn't filter by cursor on the wire, so a re-fetch
  // can return rows we've already seen) so the badge doesn't lie.
  // `discarded` rows did get inserted, so they count as new even though
  // they're rejected.
  const genuinelyNew =
    result.matched + result.pendingCeo + result.pendingCycle + result.discarded;

  const parts: string[] = [];
  if (result.newForms > 0) {
    parts.push(`${result.newForms} new form${result.newForms === 1 ? '' : 's'}`);
  }
  if (genuinelyNew > 0) {
    parts.push(
      `${genuinelyNew} new submission${genuinelyNew === 1 ? '' : 's'}`,
    );
  }

  if (parts.length === 0) {
    // Nothing actually new — but say so honestly, and mention dedupe so
    // the operator knows their click did do something.
    const dedup = result.duplicates;
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Already up to date
        {dedup > 0 && (
          <span className="text-muted-foreground">
            · {dedup} submission{dedup === 1 ? '' : 's'} re-checked, all already
            ingested
          </span>
        )}
        {result.errors.length > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            · {result.errors.length} error{result.errors.length === 1 ? '' : 's'}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-3 w-3" />
      Found {parts.join(', ')}
      {result.duplicates > 0 && (
        <span className="text-muted-foreground">
          · {result.duplicates} duplicate{result.duplicates === 1 ? '' : 's'}{' '}
          skipped
        </span>
      )}
      {result.errors.length > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          · {result.errors.length} error{result.errors.length === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}
