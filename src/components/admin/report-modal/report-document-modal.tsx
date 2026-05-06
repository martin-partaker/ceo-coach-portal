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
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { type PipelineStatus } from './pipeline-progress-bar';
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
  // The "v2 first draft" (firstDraftJson) is a SECONDARY view used by
  // the diff button only — it's not in the user-facing toggle. Primary
  // toggle is just First draft (v1) vs Polished (v2 final).
  const hasV2First = !!versions.data?.latestJob?.firstDraftJson;
  const has = useMemo(
    () => ({
      v1: !!versions.data?.v1,
      v2Final: !!versions.data?.v2,
    }),
    [versions.data],
  );

  const [version, setVersion] = useState<VersionKey>('v2-final');
  const [diffMode, setDiffMode] = useState(false);

  // Default version: prefer v2-final → v1.
  useEffect(() => {
    if (!versions.data) return;
    if (has.v2Final) setVersion('v2-final');
    else if (has.v1) setVersion('v1');
    setDiffMode(false);
  }, [versions.data, has.v2Final, has.v1, cycleId]);

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
  // The job is only meaningful for the "live progress" bar if it is in
  // a non-terminal state. A stale `pending`/`error` row from an earlier
  // attempt should not surface as "Queued — starting any moment" on a
  // cycle whose report was finished hours ago.
  const jobIsLive = !!job && job.status !== 'complete' && job.status !== 'error';
  const status: PipelineStatus = jobIsLive
    ? (job.status as PipelineStatus)
    : 'complete';
  const isRunning = jobIsLive;
  const justCompleted = job?.status === 'complete';

  // When job hits complete, refetch versions + critique + facts AND the
  // roster summary so phase pills + RecentReports refresh across the
  // workspace, not just inside this modal.
  useEffect(() => {
    if (justCompleted) {
      utils.reports.getReportVersions.invalidate({ cycleId });
      utils.reports.getForCycle.invalidate({ cycleId });
      utils.reports.getFacts.invalidate({ cycleId });
      utils.reports.getActiveJob.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
      utils.roster.cycleDetail.invalidate({ cycleId });
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
          {version === 'v2-final' && hasV2First && (
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
          {/* Tab-aware (re)generate button — sits next to the version
              toggle so the action is bound to whichever version the
              coach is currently viewing. Hidden in diff mode. */}
          {!diffMode && version === 'v1' && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => v1Regen.mutate({ cycleId })}
              disabled={v1Regen.isPending}
              title="Run the legacy single-shot generator (kept for comparison)."
            >
              {v1Regen.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              {has.v1 ? 'Re-generate first draft' : 'Generate first draft'}
            </Button>
          )}
          {!diffMode && version === 'v2-final' && (
            <Button
              type="button"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => generate.mutate({ cycleId })}
              disabled={generate.isPending || isRunning}
              title="Run the full A→B→C→D pipeline."
            >
              {generate.isPending || isRunning ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-3 w-3" />
              )}
              {has.v2Final ? 'Re-generate polished' : 'Generate polished'}
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

        {/* Error strip — only when the latest job actually failed. We
            don't render the live progress bar here anymore: while a
            generation is running, the entire body becomes a "we're
            working on it" screen below, and the corner pill shows
            ambient progress. */}
        {!jobIsLive && job?.status === 'error' && (
          <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-5 py-2 text-[12px] text-destructive">
            Last v2 generation failed: {job.error ?? 'unknown error'}. Click Re-generate v2 to try again.
          </div>
        )}

        {/* Body — boring "generating" screen WHILE running, otherwise
            diff view OR document + gutter (single scroll container so
            comments stay anchored to section cards as you scroll). */}
        <div className="flex flex-1 overflow-hidden">
          {isRunning ? (
            <GeneratingScreen status={status} />
          ) : diffMode && firstDraftShape && versions.data?.v2 ? (
            <div className="flex-1 overflow-y-auto bg-muted/10 p-6">
              <DiffView
                first={firstDraftShape}
                final={versions.data.v2.contentJson as unknown as DocumentReportShape}
              />
            </div>
          ) : (
            <div className="flex flex-1 overflow-y-auto bg-muted/10">
              <div className="flex w-full max-w-[1280px] mx-auto gap-0 p-6">
                <div className="flex-1">
                  {versions.isLoading && !activeShape && (
                    <div className="flex h-40 items-center justify-center text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  )}
                  {!versions.isLoading && !activeShape && (
                    <EmptyState onGenerate={() => generate.mutate({ cycleId })} pending={generate.isPending} />
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
                      watermark={version === 'v1' ? 'first draft' : undefined}
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
              </div>
            </div>
          )}
        </div>

        {/* Footer — minimal: timestamp + PDF download. (Re-generate
            buttons live next to the version toggle in the header so
            they're bound to whichever version is on screen.) */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-5 py-3">
          <p className="flex-1 truncate text-[11px] text-muted-foreground">
            {isRunning
              ? 'Generation runs in the background — you can close this and the corner pill will keep tracking it.'
              : justCompleted
                ? `Generated ${formatTimestamp(job?.completedAt)}.`
                : version === 'v1' && versions.data?.v1
                  ? `First draft generated ${formatTimestamp(versions.data.v1.generatedAt)}.`
                  : version === 'v2-final' && versions.data?.v2
                    ? `Polished version generated ${formatTimestamp(versions.data.v2.generatedAt)}.`
                    : 'No report generated yet.'}
          </p>
          <DownloadPdfButton cycleId={cycleId} disabled={!versions.data?.v2} />
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

/**
 * Boring "we're working on it" screen shown WHILE a generation is
 * running. Replaces the document body entirely so the coach isn't
 * looking at a stale or half-rendered report. The corner background
 * pill is responsible for ambient progress; this screen just sets
 * expectations and gets out of the way.
 */
function GeneratingScreen({ status }: { status: PipelineStatus }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-muted/10 p-10">
      <div className="max-w-md text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
        <h3 className="mt-4 text-base font-semibold">
          We're generating your report
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The full pipeline takes about 1–2 minutes — extracting facts
          from your inputs, comparing to prior cycles, drafting, then
          checking and polishing against the rubric.
        </p>
        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground/80">
          Feel free to close this and keep working. The corner pill in
          the bottom right will track progress, and the polished report
          will be here when you come back.
        </p>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground/60">
          Currently: {prettyStatus(status)}
        </p>
      </div>
    </div>
  );
}

function prettyStatus(s: PipelineStatus): string {
  switch (s) {
    case 'pending':
      return 'queued';
    case 'extracting_facts':
      return 'reading your inputs';
    case 'matching_patterns':
      return 'comparing to prior cycles';
    case 'drafting_first':
      return 'drafting the first pass';
    case 'critiquing':
      return 'reviewing against the rubric';
    case 'revising':
      return 'polishing weak sections';
    case 'finalising':
      return 'finalising';
    default:
      return 'working';
  }
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
