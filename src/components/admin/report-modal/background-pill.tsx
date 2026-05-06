'use client';

import { trpc } from '@/lib/trpc/client';
import { Loader2, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { ReportDocumentModal } from './report-document-modal';
import type { ReportGenerationJobStatus } from '@/db/schema';

/**
 * Floating bottom-right pill that surfaces every in-flight v2
 * generation job across the coach's CEOs. Stays visible even after
 * the modal that started it has been closed, so the coach knows the
 * pipeline is still running while they work elsewhere.
 *
 * Polls every 2s while at least one job is running.
 */

const STATUS_LABELS: Record<ReportGenerationJobStatus, string> = {
  pending: 'Queued',
  extracting_facts: 'Reading inputs',
  matching_patterns: 'Comparing cycles',
  drafting_first: 'Drafting',
  critiquing: 'Reviewing',
  revising: 'Polishing',
  finalising: 'Finalising',
  complete: 'Complete',
  error: 'Error',
};

export function GenerationBackgroundPill() {
  const jobs = trpc.reports.listActiveJobs.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data && q.state.data.length > 0 ? 2000 : false),
    refetchIntervalInBackground: false,
  });
  const [openCycleId, setOpenCycleId] = useState<string | null>(null);
  const [openMeta, setOpenMeta] = useState<{
    ceoName: string;
    cycleLabel: string;
  } | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const visible = (jobs.data ?? []).filter((j) => !dismissedIds.has(j.id));

  return (
    <>
      {visible.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
          {visible.map((j) => (
            <div
              key={j.id}
              className={cn(
                'pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 shadow-lg ring-1 ring-black/5',
                'transition-all hover:shadow-xl',
              )}
            >
              <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-[11px] font-semibold leading-tight">
                  {j.ceoName}
                </span>
                <span className="text-[10px] leading-tight text-muted-foreground">
                  {j.cycleLabel} ·{' '}
                  {STATUS_LABELS[j.status as ReportGenerationJobStatus] ??
                    j.status}
                  {j.revisionsApplied > 0 ? ` · rev ${j.revisionsApplied}` : ''}
                </span>
              </div>
              <button
                type="button"
                className="ml-1 inline-flex items-center gap-1 rounded-full bg-blue-500 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-blue-600"
                onClick={() => {
                  setOpenCycleId(j.cycleId);
                  setOpenMeta({ ceoName: j.ceoName, cycleLabel: j.cycleLabel });
                }}
              >
                <Sparkles className="h-2.5 w-2.5" />
                View
              </button>
              <button
                type="button"
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setDismissedIds((s) => new Set(s).add(j.id))}
                aria-label="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {openCycleId && openMeta && (
        <ReportDocumentModal
          open={!!openCycleId}
          onOpenChange={(o) => {
            if (!o) {
              setOpenCycleId(null);
              setOpenMeta(null);
            }
          }}
          cycleId={openCycleId}
          ceoName={openMeta.ceoName}
          cycleLabel={openMeta.cycleLabel}
          coachName="(your coach)"
        />
      )}
    </>
  );
}
