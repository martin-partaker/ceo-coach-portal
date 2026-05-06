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
  Loader2,
  RotateCcw,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PipelineProgressBar, type PipelineStatus } from './pipeline-progress-bar';
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
import { V2IterationInspector } from './v2-iteration-inspector';

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
      // Invalidate both the per-cycle job query (drives the in-modal
      // progress screen) and the roster-wide listActiveJobs (drives
      // each row's "Generating" pill). See roster-v2-workspace for
      // why both are needed.
      await Promise.all([
        utils.reports.getActiveJob.invalidate({ cycleId }),
        utils.reports.listActiveJobs.invalidate(),
      ]);
    },
  });

  // v2 is the only generator surfaced in the UI now. Legacy v1 reports
  // (cycles that finished on the old single-shot generator before the
  // v2 pipeline launched) are no longer viewable here — coaches who
  // need that view should re-generate v2.
  const hasV2 = !!versions.data?.v2;

  // ── shape the active version into a DocumentReportShape ──────────
  const activeShape: DocumentReportShape | null = useMemo(() => {
    if (!versions.data?.v2) return null;
    return versions.data.v2.contentJson as unknown as DocumentReportShape;
  }, [versions.data]);

  // ── comments for the gutter ──────────────────────────────────────
  const flagsFromShape = activeShape?.report?.coachReviewFlags ?? [];
  const flagsFromFacts =
    (facts.data?.factsJson as { coachReviewFlags?: typeof flagsFromShape } | null)
      ?.coachReviewFlags ?? [];
  const flags = flagsFromShape.length > 0 ? flagsFromShape : flagsFromFacts;

  const critiqueLike: CritiqueLike | null = useMemo(() => {
    if (!critique.data) return null;
    const rj = critique.data.rubricJson as CritiqueLike;
    return rj;
  }, [critique.data]);

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

  // "Break out to LLM" inspector state — shown via a button in the
  // footer next to PDF download. Only meaningful when v2 has run.
  const [breakoutOpen, setBreakoutOpen] = useState(false);

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
          {/* Re-generate dropdown. Default click reuses cached facts +
              patterns (fast retry — ~50–80s saved when Stage C/D/E
              failed). The "Re-extract from scratch" entry forces a fresh
              Stage A + B run, for cases where the operator has actually
              changed the cycle inputs and the model needs to re-read
              them. New cycles (no cache yet) take the same code path
              either way. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                className="h-7 text-[11px]"
                disabled={generate.isPending || isRunning}
                title="Run the full extract → match → draft → critique → polish pipeline."
              >
                {generate.isPending || isRunning ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 h-3 w-3" />
                )}
                {hasV2 ? 'Re-generate' : 'Generate'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[260px]">
              <DropdownMenuItem
                onClick={() => generate.mutate({ cycleId, forceRefreshFacts: false })}
                disabled={generate.isPending || isRunning}
              >
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                <div className="flex flex-col">
                  <span className="text-xs font-medium">
                    {hasV2 ? 'Re-generate (fast)' : 'Generate'}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground">
                    {hasV2
                      ? 'Reuse extracted facts; redo draft + critique.'
                      : 'Full pipeline.'}
                  </span>
                </div>
              </DropdownMenuItem>
              {hasV2 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => generate.mutate({ cycleId, forceRefreshFacts: true })}
                    disabled={generate.isPending || isRunning}
                  >
                    <RotateCcw className="mr-2 h-3.5 w-3.5" />
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">Re-extract from scratch</span>
                      <span className="text-[10.5px] text-muted-foreground">
                        Re-run Stage A + B. Use after changing cycle inputs.
                      </span>
                    </div>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
            ambient progress. The error message is collapsed by default
            because Stage A/B/C errors include long Zod / JSON-parse
            output that's unreadable as a banner. */}
        {!jobIsLive && job?.status === 'error' && (
          <FailureBanner error={job.error ?? null} />
        )}

        {/* Body — boring "generating" screen WHILE running, otherwise
            diff view OR document + gutter (single scroll container so
            comments stay anchored to section cards as you scroll). */}
        <div className="flex flex-1 overflow-hidden">
          {isRunning ? (
            <GeneratingScreen
              status={status}
              revisionsApplied={job?.revisionsApplied ?? 0}
              topFix={
                ((job?.stageDetail as { topFix?: string | null } | null)?.topFix) ??
                null
              }
              startedAt={job?.startedAt ?? null}
            />
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
                      highlightSections={highlightedSections}
                      emphasizedSection={emphasized}
                    />
                  )}
                </div>
                {activeShape && (
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
                : versions.data?.v2
                  ? `Generated ${formatTimestamp(versions.data.v2.generatedAt)}.`
                  : 'No report generated yet.'}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setBreakoutOpen(true)}
            disabled={!versions.data?.v2}
            title="Open the iteration bundle (final report + facts + critique + raw inputs + a self-contained 'iterate' prompt)."
          >
            <Wand2 className="mr-1 h-3 w-3" />
            Break out to LLM
          </Button>
          <DownloadPdfButton cycleId={cycleId} disabled={!versions.data?.v2} />
        </footer>
        <V2IterationInspector
          cycleId={cycleId}
          cycleLabel={cycleLabel}
          ceoName={ceoName}
          open={breakoutOpen}
          onOpenChange={setBreakoutOpen}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compact failure strip with an expandable detail. Stage A/B/C errors
 * include long Zod / JSON-parse output that's unreadable inline, so we
 * show a one-line summary by default and let the operator expand for
 * the raw payload.
 */
function FailureBanner({ error }: { error: string | null }) {
  const [open, setOpen] = useState(false);
  const summary = summariseError(error);
  return (
    <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-5 py-2 text-[12px] text-destructive">
      <div className="flex items-center gap-2">
        <span>
          <span className="font-medium">Last v2 generation failed.</span> {summary}{' '}
          Click <span className="font-medium">Re-generate v2</span> to try again.
        </span>
        {error && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="ml-auto shrink-0 underline-offset-2 hover:underline"
          >
            {open ? 'hide details' : 'show details'}
          </button>
        )}
      </div>
      {open && error && (
        <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-destructive/30 bg-background/60 px-2 py-1.5 font-mono text-[10.5px] text-foreground/90">
          {error}
        </pre>
      )}
    </div>
  );
}

/**
 * Reduce a long error blob to a single readable sentence. Pipeline
 * errors are prefixed with the stage name (e.g. "Stage A: tool output
 * failed CycleFactsSchema validation"); we keep the prefix and trim
 * the trailing payload.
 */
function summariseError(error: string | null): string {
  if (!error) return 'Unknown error.';
  const stageMatch = error.match(/^(Stage [A-E][^:]*: [^—\n]+)/);
  if (stageMatch) return stageMatch[1].trim() + '.';
  // Strip newlines + truncate as a fallback.
  const flat = error.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? flat.slice(0, 160).trimEnd() + '…' : flat;
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
function GeneratingScreen({
  status,
  revisionsApplied,
  topFix,
  startedAt,
}: {
  status: PipelineStatus;
  revisionsApplied: number;
  topFix: string | null;
  startedAt: Date | string | null;
}) {
  const elapsed = useElapsedSeconds(startedAt);

  return (
    <div className="flex flex-1 items-center justify-center bg-muted/10 p-6 sm:p-10">
      <div className="w-full max-w-2xl text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
        <h3 className="mt-4 text-base font-semibold">
          We're generating your report
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The full pipeline takes about 10 minutes — extracting facts
          from your inputs, comparing to prior cycles, drafting, then
          checking and polishing against the rubric.
        </p>

        {/* Live stage strip + elapsed timer. Compact size for tight fit;
            details are shown in the line under the bar. */}
        <div className="mx-auto mt-6 max-w-xl rounded-lg border border-border bg-background px-3 py-3 text-left sm:px-4">
          <PipelineProgressBar
            size="compact"
            status={status}
            revisionsApplied={revisionsApplied}
            topFix={topFix}
            elapsedSeconds={elapsed}
          />
        </div>

        <p className="mt-5 text-[12px] leading-relaxed text-muted-foreground/80">
          Feel free to close this and keep working. The corner pill in
          the bottom right will track progress, and the polished report
          will be here when you come back.
        </p>
      </div>
    </div>
  );
}

/** Tick once a second so the elapsed time on the generating screen
 *  reads "0:14 → 0:15 → 0:16" rather than freezing. Returns null if
 *  no startedAt provided. */
function useElapsedSeconds(startedAt: Date | string | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() =>
    startedAt ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : null,
  );
  useEffect(() => {
    if (!startedAt) {
      setElapsed(null);
      return;
    }
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
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
