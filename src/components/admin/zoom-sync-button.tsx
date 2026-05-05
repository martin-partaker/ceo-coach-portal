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
  coaches: number;
  meetings: number;
  ingested: number;
  matched: number;
  pendingCeo: number;
  duplicates: number;
  discarded: number;
  errors: Array<{ coachId: string; phase: string; message: string }>;
}

/**
 * Manual Zoom backfill button. Pulls a full 12-month window for every
 * coach with a Zoom email and re-ingests anything that's missing. Safe
 * to click repeatedly — duplicates are skipped at the DB unique constraint.
 */
export function ZoomSyncButton() {
  const utils = trpc.useUtils();
  const lastSync = trpc.inbox.lastZoomSync.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const [result, setResult] = useState<SyncResult | null>(null);

  const sync = trpc.inbox.syncZoom.useMutation({
    onSuccess: (data) => {
      setResult(data);
      utils.inbox.lastZoomSync.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    },
  });

  const lastSuccess = lastSync.data?.lastSuccessAt ?? null;
  const cronErrors = lastSync.data?.errors ?? [];
  const busy = sync.isPending;

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
      {result && !sync.isPending && <SyncSummary result={result} />}

      {sync.error && (
        <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
          <AlertTriangle className="h-3 w-3" />
          {sync.error.message}
        </span>
      )}

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
  );
}

function SyncSummary({ result }: { result: SyncResult }) {
  // "Genuinely new" = Zoom meetings that produced a new raw_input row.
  // Excludes duplicates (already ingested by a prior run/cron); includes
  // pending_ceo (most Zoom transcripts land here for human triage) and
  // discarded (rejected at ingest, but they did create a row).
  const genuinelyNew = result.matched + result.pendingCeo + result.discarded;

  if (genuinelyNew === 0) {
    const dedup = result.duplicates;
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Already up to date
        {dedup > 0 && (
          <span className="text-muted-foreground">
            · {dedup} meeting{dedup === 1 ? '' : 's'} re-checked, all already
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
      Found {genuinelyNew} new meeting{genuinelyNew === 1 ? '' : 's'}
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
