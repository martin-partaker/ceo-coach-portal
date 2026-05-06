'use client';

import { Check, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReportGenerationJobStatus } from '@/db/schema';

/**
 * 5-stage horizontal progress bar.
 *
 *   Reading inputs → Comparing cycles → Drafting → Reviewing → Polishing
 *
 * Each step has 3 visual states: idle, active (spinner), done (check).
 * After completion the bar stays on screen as a "history strip" so the
 * coach can see what happened.
 */

export type PipelineStatus = ReportGenerationJobStatus;

const STAGES: Array<{
  id: PipelineStatus[];
  label: string;
  shortLabel: string;
}> = [
  { id: ['extracting_facts'], label: 'Reading your inputs', shortLabel: 'Reading inputs' },
  { id: ['matching_patterns'], label: 'Comparing to prior cycles', shortLabel: 'Comparing cycles' },
  { id: ['drafting_first'], label: 'Writing the first draft', shortLabel: 'Drafting' },
  { id: ['critiquing'], label: 'Checking against the rubric', shortLabel: 'Reviewing' },
  {
    id: ['revising', 'finalising'],
    label: 'Polishing weak sections',
    shortLabel: 'Polishing',
  },
];

const STATUS_INDEX: Record<PipelineStatus, number> = {
  pending: -1,
  extracting_facts: 0,
  matching_patterns: 1,
  drafting_first: 2,
  critiquing: 3,
  revising: 4,
  finalising: 4,
  complete: 5, // past last
  error: -2,
};

export function PipelineProgressBar({
  status,
  revisionsApplied,
  topFix,
  size = 'normal',
  errorText,
  /** When true, render compactly with no long detail line and short
   *  labels — for embedding in tight UI like the generating screen
   *  card or the corner pill. */
  hideDetail = false,
  elapsedSeconds,
}: {
  status: PipelineStatus;
  revisionsApplied?: number;
  topFix?: string | null;
  size?: 'normal' | 'compact';
  errorText?: string | null;
  hideDetail?: boolean;
  elapsedSeconds?: number | null;
}) {
  const isError = status === 'error';
  const isComplete = status === 'complete';
  const activeIdx = isError
    ? -1
    : isComplete
      ? STAGES.length
      : STATUS_INDEX[status];

  const compact = size === 'compact';

  return (
    <div className={cn('w-full', compact ? 'space-y-1.5' : 'space-y-2')}>
      {/* The bar itself — flex-wrap on small screens so each stage drops
          to a new line instead of overflowing. */}
      <div className="flex flex-wrap items-start gap-x-1 gap-y-2 sm:flex-nowrap">
        {STAGES.map((stage, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx && !isError && !isComplete;
          const isLast = i === STAGES.length - 1;
          return (
            <div
              key={stage.shortLabel}
              className="flex min-w-0 basis-1/2 sm:flex-1 sm:basis-0 items-center gap-1"
            >
              <div className="flex min-w-0 flex-1 flex-col items-start">
                <div className="flex w-full min-w-0 items-center gap-1.5">
                  <StageDot done={done} active={active} error={isError && i === 0} />
                  <span
                    className={cn(
                      compact ? 'text-[10px]' : 'text-[11px]',
                      'truncate font-medium',
                      done
                        ? 'text-foreground/80'
                        : active
                          ? 'text-foreground'
                          : 'text-muted-foreground/60',
                    )}
                    title={stage.label}
                  >
                    {stage.shortLabel}
                  </span>
                </div>
                {!isLast && (
                  <div
                    className={cn(
                      'mt-1 hidden h-0.5 w-full rounded-full transition-colors sm:block',
                      done
                        ? 'bg-emerald-500/60'
                        : active
                          ? 'bg-blue-500/60'
                          : 'bg-border/60',
                    )}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sub-line: status detail. Hidden when hideDetail=true; topFix
          truncated so a long sentence doesn't blow up the layout. */}
      {!hideDetail && !isError && !isComplete && (
        <div
          className={cn(
            'flex items-baseline gap-2',
            compact ? 'text-[10px]' : 'text-[11px]',
          )}
        >
          <span className="line-clamp-2 flex-1 text-muted-foreground">
            {statusDetailLine(status, revisionsApplied, topFix)}
          </span>
          {typeof elapsedSeconds === 'number' && (
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
              {formatElapsed(elapsedSeconds)}
            </span>
          )}
        </div>
      )}
      {hideDetail && typeof elapsedSeconds === 'number' && !isError && !isComplete && (
        <p
          className={cn(
            'font-mono tabular-nums text-muted-foreground/70',
            compact ? 'text-[10px]' : 'text-[11px]',
          )}
        >
          {formatElapsed(elapsedSeconds)} elapsed
        </p>
      )}
      {isComplete && (
        <p className={cn('text-emerald-600 dark:text-emerald-400', compact ? 'text-[10px]' : 'text-[11px]')}>
          Complete{revisionsApplied && revisionsApplied > 0
            ? ` · polished ${revisionsApplied}× to clear the rubric`
            : ' · cleared the rubric on the first pass'}
          {typeof elapsedSeconds === 'number' && ` · took ${formatElapsed(elapsedSeconds)}`}
        </p>
      )}
      {isError && (
        <p className={cn('text-destructive', compact ? 'text-[10px]' : 'text-[11px]')}>
          Error · {errorText ?? 'see logs'}
        </p>
      )}
    </div>
  );
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function StageDot({
  done,
  active,
  error,
}: {
  done: boolean;
  active: boolean;
  error?: boolean;
}) {
  if (error) {
    return (
      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
        <AlertCircle className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (done) {
    return (
      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Check className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (active) {
    return (
      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      </span>
    );
  }
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-border bg-background">
      <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
    </span>
  );
}

function statusDetailLine(
  status: PipelineStatus,
  revisionsApplied?: number,
  topFix?: string | null,
): string {
  switch (status) {
    case 'pending':
      return 'Queued — starting any moment.';
    case 'extracting_facts':
      return 'Pulling typed facts from journals, transcript, KPIs, and reflections (Stage A).';
    case 'matching_patterns':
      return 'Comparing this cycle to prior cycles for cross-cycle patterns (Stage B).';
    case 'drafting_first':
      return 'Writing the first full draft against the rubric and the gold-standard exemplars (Stage C).';
    case 'critiquing':
      return revisionsApplied && revisionsApplied > 0
        ? `Re-checking the rubric on revision ${revisionsApplied} (Stage D).`
        : 'Scoring the first draft against the 9-row quality rubric (Stage D).';
    case 'revising':
      return topFix
        ? `Rewriting weak sections — top fix: ${topFix}`
        : 'Rewriting only the weak sections the rubric flagged (Stage C, revision).';
    case 'finalising':
      return 'Validating resources and persisting the final report.';
    default:
      return '';
  }
}
