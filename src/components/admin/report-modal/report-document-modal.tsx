'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Download,
  GitCompare,
  Loader2,
  Mail,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PipelineProgressBar,
  type PipelineStatus,
} from './pipeline-progress-bar';
import {
  DocumentRenderer,
  type DocumentReportShape,
  type DocumentSectionId,
} from './document-renderer';
import {
  CommentGutter,
  buildComments,
  type CritiqueLike,
} from './comment-gutter';
import { VersionToggle, type VersionKey } from './version-toggle';
import { DiffView } from './diff-view';

/**
 * Full-screen modal that replaces the side-drawer report reviewer.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────────┐
 *   │ Title                          [version toggle] [×]   │
 *   ├───────────────────────────────────────────────────────┤
 *   │ Pipeline progress bar (live during generation)        │
 *   ├──────────────────────────────────────┬────────────────┤
 *   │                                      │                │
 *   │   PDF-style document                 │ Comment gutter │
 *   │   (renders the active version)       │ (Google Docs)  │
 *   │                                      │                │
 *   ├──────────────────────────────────────┴────────────────┤
 *   │ [Download PDF]  [Email view]  [v1 regen]  [Generate v2]│
 *   └───────────────────────────────────────────────────────┘
 *
 * Polls `getActiveJob` every 1.5s while a job is non-terminal so the
 * progress bar fills in live. On completion, refetches reports + facts
 * + critique and the document materializes.
 */

type Props = {
  cycleId: string;
  ceoName: string;
  cycleLabel: string;
  /** Coach name for the document header. Defaults to a placeholder if
   *  not passed (the generated PDF has the real coach name baked in
   *  by the server prompt). */
  coachName?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ReportDocumentModal({
  cycleId,
  ceoName,
  cycleLabel,
  coachName = '(coach)',
  periodStart,
  periodEnd,
  open,
  onOpenChange,
}: Props) {
  const utils = trpc.useUtils();

  const versions = trpc.reports.getReportVersions.useQuery(
    { cycleId },
    { enabled: open, staleTime: 5_000 },
  );
  const activeJob = trpc.reports.getActiveJob.useQuery(
    { cycleId },
    {
      enabled: open,
      // 1.5s polling while non-terminal; otherwise stop.
      refetchInterval: (q) => {
        const data = q.state.data;
        if (!data) return false;
        if (data.status === 'complete' || data.status === 'error') return false;
        return 1500;
      },
    },
  );
  const facts = trpc.reports.getFacts.useQuery({ cycleId }, { enabled: open });
  const v2ReportId = versions.data?.v2?.id;
  const critique = trpc.reports.getCritique.useQuery(
    { reportId: v2ReportId ?? '' },
    { enabled: !!v2ReportId },
  );

  // Generate mutation — kicks off and returns immediately.
  const generate = trpc.reports.generateV2.useMutation({
    onSuccess: async () => {
      // Force a refetch of the active job so polling picks it up
      // immediately rather than after the next 1.5s tick.
      await utils.reports.getActiveJob.invalidate({ cycleId });
    },
  });

  const v1Regen = trpc.reports.generate.useMutation({
    onSuccess: async () => {
      await utils.reports.getReportVersions.invalidate({ cycleId });
      await utils.reports.getForCycle.invalidate({ cycleId });
    },
  });

  // ── version state ────────────────────────────────────────────────
  const has = useMemo(
    () => ({
      v1: !!versions.data?.v1,
      v2First: !!versions.data?.latestJob?.firstDraftJson,
      v2Final: !!versions.data?.v2,
    }),
    [versions.data],
  );

  const [version, setVersion] = useState<VersionKey>('v2-final');
  const [diffMode, setDiffMode] = useState(false);

  // Default version: prefer v2-final → v2-first → v1.
  useEffect(() => {
    if (!versions.data) return;
    if (has.v2Final) setVersion('v2-final');
    else if (has.v2First) setVersion('v2-first');
    else if (has.v1) setVersion('v1');
    setDiffMode(false);
  }, [versions.data, has.v2Final, has.v2First, has.v1, cycleId]);

  // Reset to default tab on open / cycle change.
  useEffect(() => {
    if (open) setDiffMode(false);
  }, [open, cycleId]);

  // ── shape the active version into a DocumentReportShape ──────────
  const activeShape: DocumentReportShape | null = useMemo(() => {
    if (!versions.data) return null;
    if (version === 'v1' && versions.data.v1) {
      return versions.data.v1.contentJson as unknown as DocumentReportShape;
    }
    if (version === 'v2-first' && versions.data.latestJob?.firstDraftJson) {
      return versions.data.latestJob.firstDraftJson as unknown as DocumentReportShape;
    }
    if (version === 'v2-final' && versions.data.v2) {
      return versions.data.v2.contentJson as unknown as DocumentReportShape;
    }
    return null;
  }, [version, versions.data]);

  // ── comments for the gutter ──────────────────────────────────────
  const flagsFromShape = activeShape?.report?.coachReviewFlags ?? [];
  const flagsFromFacts =
    (facts.data?.factsJson as { coachReviewFlags?: typeof flagsFromShape } | null)
      ?.coachReviewFlags ?? [];
  const flags = flagsFromShape.length > 0 ? flagsFromShape : flagsFromFacts;

  const critiqueLike: CritiqueLike | null = useMemo(() => {
    if (!critique.data || version !== 'v2-final') return null;
    const rj = critique.data.rubricJson as CritiqueLike;
    return rj;
  }, [critique.data, version]);

  const comments = useMemo(
    () => buildComments({ critique: critiqueLike, flags }),
    [critiqueLike, flags],
  );

  const highlightedSections = useMemo(() => {
    const set = new Set<DocumentSectionId>();
    for (const c of comments) if (c.targetSection) set.add(c.targetSection);
    return set;
  }, [comments]);

  // ── job + progress state ─────────────────────────────────────────
  const job = activeJob.data;
  const status: PipelineStatus = (job?.status as PipelineStatus) ?? 'pending';
  const isRunning = !!job && status !== 'complete' && status !== 'error';
  const justCompleted = job?.status === 'complete';

  // When job hits complete, refetch versions + critique + facts.
  useEffect(() => {
    if (justCompleted) {
      utils.reports.getReportVersions.invalidate({ cycleId });
      utils.reports.getForCycle.invalidate({ cycleId });
      utils.reports.getFacts.invalidate({ cycleId });
      utils.reports.getActiveJob.invalidate({ cycleId });
      if (job?.finalReportId) {
        utils.reports.getCritique.invalidate({ reportId: job.finalReportId });
      }
    }
  }, [justCompleted, cycleId, job?.finalReportId, utils]);

  // ── document container ref for the gutter to anchor against ──────
  const documentRef = useRef<HTMLDivElement | null>(null);
  const [emphasized, setEmphasized] = useState<DocumentSectionId | null>(null);

  // First draft for diff
  const firstDraftShape = (versions.data?.latestJob?.firstDraftJson ?? null) as
    | DocumentReportShape
    | null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[92vh] w-[96vw] max-w-[1400px] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[1400px]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          Monthly Progress Summary — {ceoName} — {cycleLabel}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Review and refine the v2 monthly coaching report.
        </DialogDescription>

        {/* Header */}
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/20 px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">
              Monthly Progress Summary
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {ceoName} · {cycleLabel}
              {periodEnd ? ` · ends ${new Date(periodEnd).toLocaleDateString()}` : ''}
            </p>
          </div>
          <VersionToggle
            value={version}
            onChange={setVersion}
            has={has}
          />
          {version === 'v2-final' && has.v2First && (
            <Button
              type="button"
              size="sm"
              variant={diffMode ? 'default' : 'outline'}
              className="h-7 text-[11px]"
              onClick={() => setDiffMode((d) => !d)}
              title="Show what the rubric critic improved between first draft and polished version"
            >
              <GitCompare className="mr-1 h-3 w-3" />
              {diffMode ? 'Hide diff' : 'Show what improved'}
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        {/* Pipeline progress bar */}
        <div className="shrink-0 border-b border-border bg-background px-5 py-3">
          <PipelineProgressBar
            status={status}
            revisionsApplied={job?.revisionsApplied ?? 0}
            topFix={
              ((job?.stageDetail as { topFix?: string | null } | null)?.topFix) ?? null
            }
            errorText={job?.error ?? null}
          />
        </div>

        {/* Body — diff view OR document + gutter */}
        <div className="flex flex-1 overflow-hidden">
          {diffMode && firstDraftShape && versions.data?.v2 ? (
            <div className="flex-1 overflow-y-auto bg-muted/10 p-6">
              <DiffView
                first={firstDraftShape}
                final={versions.data.v2.contentJson as unknown as DocumentReportShape}
              />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto bg-muted/10 p-6">
                {versions.isLoading && !activeShape && (
                  <div className="flex h-40 items-center justify-center text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                )}
                {!versions.isLoading && !activeShape && !isRunning && (
                  <EmptyState onGenerate={() => generate.mutate({ cycleId })} pending={generate.isPending} />
                )}
                {!versions.isLoading && !activeShape && isRunning && (
                  <RunningSkeleton />
                )}
                {activeShape && (
                  <DocumentRenderer
                    ref={documentRef}
                    report={activeShape}
                    ceoName={ceoName}
                    cycleLabel={cycleLabel}
                    coachName={coachName}
                    periodStart={periodStart}
                    periodEnd={periodEnd}
                    highlightSections={
                      version === 'v2-final' ? highlightedSections : undefined
                    }
                    emphasizedSection={emphasized}
                    watermark={
                      version === 'v2-first'
                        ? 'first draft'
                        : version === 'v1'
                          ? 'v1 (legacy)'
                          : undefined
                    }
                  />
                )}
              </div>
              {version === 'v2-final' && activeShape && (
                <CommentGutter
                  comments={comments}
                  documentContainer={documentRef.current}
                  onHoverSection={(id) => setEmphasized(id)}
                />
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-5 py-3">
          <p className="flex-1 truncate text-[11px] text-muted-foreground">
            {isRunning
              ? 'Generation runs in the background — you can close this and the corner pill will keep tracking it.'
              : justCompleted
                ? `Generated ${formatTimestamp(job?.completedAt)}.`
                : versions.data?.v2
                  ? `Last generated ${formatTimestamp(versions.data.v2.generatedAt)}.`
                  : 'No v2 report generated yet.'}
          </p>
          <DownloadPdfButton cycleId={cycleId} disabled={!versions.data?.v2} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => v1Regen.mutate({ cycleId })}
            disabled={v1Regen.isPending}
            title="Run the legacy single-shot generator (kept for comparison)."
          >
            {v1Regen.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Mail className="mr-1 h-3 w-3" />
            )}
            v1 single-shot
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => generate.mutate({ cycleId })}
            disabled={generate.isPending || isRunning}
            title="Run the full A→B→C→D pipeline."
          >
            {generate.isPending || isRunning ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3" />
            )}
            {versions.data?.v2 ? 'Re-generate v2' : 'Generate v2'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({
  onGenerate,
  pending,
}: {
  onGenerate: () => void;
  pending: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background p-10 text-center">
      <Sparkles className="mb-2 h-5 w-5 text-blue-500" />
      <h3 className="text-sm font-semibold">No report generated yet</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Run the v2 pipeline to extract typed facts, compare to prior cycles,
        write the report, and review it against the 9-row rubric.
      </p>
      <Button size="sm" className="mt-4" onClick={onGenerate} disabled={pending}>
        {pending ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="mr-1 h-3 w-3" />
        )}
        Generate v2
      </Button>
    </div>
  );
}

function RunningSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 rounded-md border border-dashed border-blue-500/30 bg-background p-10">
      <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Generating — pipeline running…
      </div>
      <p className="text-[12px] text-muted-foreground">
        The progress bar above shows which stage is active. The document
        will materialize here once the drafter (Stage C) finishes its
        first pass.
      </p>
      <div className="space-y-2">
        <div className="h-3 w-1/3 rounded bg-muted/60" />
        <div className="h-3 w-2/3 rounded bg-muted/60" />
        <div className="h-3 w-1/2 rounded bg-muted/60" />
      </div>
    </div>
  );
}

function DownloadPdfButton({
  cycleId,
  disabled,
}: {
  cycleId: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  async function download() {
    if (disabled) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/reports/${cycleId}/pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `monthly-summary-${cycleId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={download}
      disabled={disabled || busy}
    >
      {busy ? (
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      ) : (
        <Download className="mr-1 h-3 w-3" />
      )}
      PDF
    </Button>
  );
}

function formatTimestamp(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
