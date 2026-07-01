'use client';

import { forwardRef } from 'react';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { cn } from '@/lib/utils';
import type { CycleMomentum } from '@/lib/journal/cycle-momentum';
import { RefineSectionPopover } from './refine-section-popover';

/**
 * Renders a v2 DraftedReport as a styled document that mimics the PDF
 * "Monthly Progress Summary". Each section card has a `data-section`
 * attribute so the right-gutter CommentGutter can anchor comments via
 * a `useEffect` lookup of section bounding rects.
 *
 * Layout:
 *   ┌─────────────────────────────────────┐
 *   │  Monthly Progress Summary           │  ← title
 *   │  Coach · Reporting period · Cycle   │  ← subhead
 *   │                                     │
 *   │  1. Goal Summary                    │  ← data-section="goalSummary"
 *   │     10x: …                          │
 *   │     90-day: …                       │
 *   │     30-day: …                       │
 *   │     Flag: …                         │
 *   │                                     │
 *   │  2. Progress Summary                │  ← data-section="progressSummary"
 *   │     prose…                          │
 *   │                                     │
 *   │  3. Key Wins                        │  ← data-section="keyWins"
 *   │     • …                             │
 *   │  4. Challenges & Patterns           │  ← data-section="challenges"
 *   │  5. Pattern Observations            │  ← data-section="patternObservations"
 *   │  6. Recommended Next Steps          │  ← data-section="suggestedNextSteps"
 *   └─────────────────────────────────────┘
 */

export type DocumentSectionId =
  | 'goalSummary'
  | 'progressSummary'
  | 'keyWins'
  | 'challenges'
  | 'patternObservations'
  | 'suggestedNextSteps';

export type DocumentReportShape = {
  // Email view (used by the Email variant only)
  subject_line?: string;
  opening?: string;
  wins_and_progress?: string;
  honest_feedback?: string;
  key_insight?: string;
  commitments?: string;
  closing?: string;
  going_deeper?: string;
  // Structured report view
  report?: {
    progressSummary?: string;
    keyWins?: string[];
    challenges?: string[];
    patternObservations?: string;
    suggestedNextSteps?: string[];
    suggestedResourceIds?: string[];
    goalSummary?: {
      tenX?: string;
      ninetyDay?: string | null;
      thirtyDay?: string | null;
      flag?: string | null;
    } | null;
    coachReviewFlags?: Array<{
      title: string;
      detail: string;
      urgency?: 'info' | 'attention' | 'urgent';
    }>;
    closing?: {
      sentence: string;
      nextSessionDate: string | null;
    } | null;
  };
};

type Props = {
  report: DocumentReportShape;
  ceoName: string;
  cycleLabel: string;
  coachName: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Highlight set — the IDs in here get a subtle yellow ring so the
   *  coach can see which sections have open comments. */
  highlightSections?: Set<DocumentSectionId>;
  /** Hover handler — when a comment in the gutter is hovered, the
   *  caller passes the sectionId so the document can scroll to and
   *  emphasize that section. */
  emphasizedSection?: DocumentSectionId | null;
  /** Click handler — used to focus a section's chat. */
  onSectionClick?: (id: DocumentSectionId) => void;
  /** When true, render a "draft" watermark — used to distinguish first
   *  draft vs revised in the version toggle. */
  watermark?: string;
  /** When provided, each section gets a hover "Refine" affordance that
   *  opens a per-section chat (Stage E). Omit on legacy views that
   *  don't have a refineable backing report. */
  reportId?: string;
  /** Weekly-journal well-being averages for the Momentum Check section.
   *  Rendered as a stoplight table above the progress prose. Omitted when
   *  no journal scores exist for the cycle. */
  momentum?: CycleMomentum | null;
};

export const DocumentRenderer = forwardRef<HTMLDivElement, Props>(function DocumentRenderer(
  {
    report,
    ceoName,
    cycleLabel,
    coachName,
    periodStart,
    periodEnd,
    highlightSections,
    emphasizedSection,
    onSectionClick,
    watermark,
    reportId,
    momentum,
  },
  ref,
) {
  const r = report.report ?? {};
  const period = formatPeriod(periodStart, periodEnd);

  return (
    <div
      ref={ref}
      className="relative mx-auto w-full max-w-3xl bg-background px-10 py-12 text-foreground shadow-sm ring-1 ring-border"
      style={{ minHeight: '60vh' }}
    >
      {watermark && (
        <div className="pointer-events-none absolute right-6 top-6 select-none rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
          {watermark}
        </div>
      )}

      {/* Title block */}
      <header className="mb-8 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">
          Monthly Progress Summary
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {ceoName} · {cycleLabel}
          {period && (
            <>
              {' · '}
              <span>Reporting Period: {period}</span>
            </>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground/80">
          Prepared by {coachName}
        </p>
      </header>

      <div className="space-y-7">
        {/* 1. Goal Summary */}
        {r.goalSummary && (r.goalSummary.tenX || r.goalSummary.ninetyDay || r.goalSummary.thirtyDay) && (
          <DocSection
            id="goalSummary"
            number={1}
            title="Goal Summary"
            highlighted={highlightSections?.has('goalSummary')}
            emphasized={emphasizedSection === 'goalSummary'}
            onClick={() => onSectionClick?.('goalSummary')}
            reportId={reportId}
          >
            <dl className="space-y-2 text-[14px] leading-relaxed">
              {r.goalSummary.tenX && (
                <div>
                  <dt className="inline font-semibold">10x Goal: </dt>
                  <dd className="inline">
                    <MarkdownInline text={r.goalSummary.tenX} />
                  </dd>
                </div>
              )}
              {r.goalSummary.ninetyDay && (
                <div>
                  <dt className="inline font-semibold">90-Day Goal: </dt>
                  <dd className="inline">
                    <MarkdownInline text={r.goalSummary.ninetyDay} />
                  </dd>
                </div>
              )}
              {r.goalSummary.thirtyDay && (
                <div>
                  <dt className="inline font-semibold">30-Day Goal: </dt>
                  <dd className="inline">
                    <MarkdownInline text={r.goalSummary.thirtyDay} />
                  </dd>
                </div>
              )}
            </dl>
            {r.goalSummary.flag && (
              <div className="mt-3 rounded border-l-4 border-amber-500 bg-amber-500/5 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
                <span className="font-semibold">⚑ Flag for Coach Review:</span>{' '}
                <MarkdownInline text={r.goalSummary.flag} />
              </div>
            )}
          </DocSection>
        )}

        {/* 2. Momentum Check (was: Progress Summary) */}
        {(r.progressSummary || (momentum && momentum.rows.length > 0)) && (
          <DocSection
            id="progressSummary"
            number={r.goalSummary ? 2 : 1}
            title="Momentum Check"
            highlighted={highlightSections?.has('progressSummary')}
            emphasized={emphasizedSection === 'progressSummary'}
            onClick={() => onSectionClick?.('progressSummary')}
            reportId={reportId}
          >
            {momentum && momentum.rows.length > 0 && (
              <MomentumTable momentum={momentum} />
            )}
            {r.progressSummary && <Markdown text={r.progressSummary} size="sm" />}
          </DocSection>
        )}

        {/* 3. Key Wins */}
        {r.keyWins && r.keyWins.length > 0 && (
          <DocSection
            id="keyWins"
            number={(r.goalSummary ? 1 : 0) + (r.progressSummary ? 1 : 0) + 1}
            title="Key Wins"
            highlighted={highlightSections?.has('keyWins')}
            emphasized={emphasizedSection === 'keyWins'}
            onClick={() => onSectionClick?.('keyWins')}
            reportId={reportId}
          >
            <ul className="ml-5 list-disc space-y-1.5 text-[14px] leading-relaxed marker:text-emerald-500">
              {r.keyWins.map((w, i) => (
                <li key={i}>
                  <MarkdownInline text={w} />
                </li>
              ))}
            </ul>
          </DocSection>
        )}

        {/* 4. Challenges */}
        {r.challenges && r.challenges.length > 0 && (
          <DocSection
            id="challenges"
            number={
              (r.goalSummary ? 1 : 0) +
              (r.progressSummary ? 1 : 0) +
              (r.keyWins?.length ? 1 : 0) +
              1
            }
            title="Challenges and Patterns"
            highlighted={highlightSections?.has('challenges')}
            emphasized={emphasizedSection === 'challenges'}
            onClick={() => onSectionClick?.('challenges')}
            reportId={reportId}
          >
            <ul className="ml-5 list-disc space-y-1.5 text-[14px] leading-relaxed marker:text-amber-500">
              {r.challenges.map((c, i) => (
                <li key={i}>
                  <MarkdownInline text={c} />
                </li>
              ))}
            </ul>
          </DocSection>
        )}

        {/* 5. Flight Patterns (was: Pattern Observations) */}
        {r.patternObservations && (
          <DocSection
            id="patternObservations"
            number={
              (r.goalSummary ? 1 : 0) +
              (r.progressSummary ? 1 : 0) +
              (r.keyWins?.length ? 1 : 0) +
              (r.challenges?.length ? 1 : 0) +
              1
            }
            title="Flight Patterns"
            highlighted={highlightSections?.has('patternObservations')}
            emphasized={emphasizedSection === 'patternObservations'}
            onClick={() => onSectionClick?.('patternObservations')}
            reportId={reportId}
          >
            <Markdown text={r.patternObservations} size="sm" />
          </DocSection>
        )}

        {/* 6. Flight Plan: Recommended Next Steps */}
        {r.suggestedNextSteps && r.suggestedNextSteps.length > 0 && (
          <DocSection
            id="suggestedNextSteps"
            number={
              (r.goalSummary ? 1 : 0) +
              (r.progressSummary ? 1 : 0) +
              (r.keyWins?.length ? 1 : 0) +
              (r.challenges?.length ? 1 : 0) +
              (r.patternObservations ? 1 : 0) +
              1
            }
            title="Flight Plan: Recommended Next Steps"
            highlighted={highlightSections?.has('suggestedNextSteps')}
            emphasized={emphasizedSection === 'suggestedNextSteps'}
            onClick={() => onSectionClick?.('suggestedNextSteps')}
            reportId={reportId}
          >
            <ol className="ml-5 list-decimal space-y-1.5 text-[14px] leading-relaxed marker:font-semibold marker:text-blue-500">
              {r.suggestedNextSteps.map((s, i) => (
                <li key={i}>
                  <MarkdownInline text={s} />
                </li>
              ))}
            </ol>
          </DocSection>
        )}

        {/* Closing — encouraging sign-off + next session date */}
        {r.closing && r.closing.sentence && (
          <ClosingBlock
            sentence={r.closing.sentence}
            nextSessionDate={r.closing.nextSessionDate ?? null}
          />
        )}
      </div>
    </div>
  );
});

const STOPLIGHT_BG: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
};

/**
 * On-screen Momentum Check well-being table — mirrors the PDF. Four
 * weekly-journal averages (energy / focus / stress / highest-leverage)
 * with a stoplight dot, this month vs. prior month when prior data
 * exists. Sits above the "Minutes dedicated to the 10x goal" prose.
 */
function MomentumTable({ momentum }: { momentum: CycleMomentum }) {
  const hasPrev =
    momentum.previousLabel !== null && momentum.rows.some((r) => r.previous);
  return (
    <div className="mb-4">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border">
            <th className="py-1.5 pr-3 text-left font-semibold">
              Weekly check-in
            </th>
            <th className="py-1.5 pr-3 text-left font-semibold">
              {momentum.currentLabel}
            </th>
            {hasPrev && (
              <th className="py-1.5 text-left font-semibold text-muted-foreground">
                {momentum.previousLabel}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {momentum.rows.map((r) => (
            <tr key={r.key} className="border-b border-border/60">
              <td className="py-1.5 pr-3">{r.label}</td>
              <td className="py-1.5 pr-3">
                <MomentumScore cell={r.current} />
              </td>
              {hasPrev && (
                <td className="py-1.5">
                  <MomentumScore cell={r.previous} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Averaged from weekly journals. Green 8–10, Yellow 5–7, Red 1–4
        (stress is reversed, so a high score is red).
      </p>
    </div>
  );
}

function MomentumScore({
  cell,
}: {
  cell: { avg: number; color: 'green' | 'yellow' | 'red' } | null;
}) {
  if (!cell) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn('inline-block h-2.5 w-2.5 rounded-full', STOPLIGHT_BG[cell.color])}
      />
      {cell.avg.toFixed(1)}
    </span>
  );
}

function ClosingBlock({
  sentence,
  nextSessionDate,
}: {
  sentence: string;
  nextSessionDate: string | null;
}) {
  return (
    <section
      data-section="closing"
      className="mt-2 border-t border-border pt-5 text-[14px] leading-relaxed"
    >
      <p className="italic text-foreground/90">
        <MarkdownInline text={sentence} />
      </p>
      {nextSessionDate && (
        <p className="mt-2 font-semibold">Next session: {nextSessionDate}</p>
      )}
    </section>
  );
}

function DocSection({
  id,
  number,
  title,
  children,
  highlighted,
  emphasized,
  onClick,
  reportId,
}: {
  id: DocumentSectionId;
  number: number;
  title: string;
  children: React.ReactNode;
  highlighted?: boolean;
  emphasized?: boolean;
  onClick?: () => void;
  reportId?: string;
}) {
  // `goalSummary` isn't a refineable section (it's derived from
  // CycleFacts); the rest map 1:1 to the refine schema's RefinableSection.
  const refineSection: string | null = id === 'goalSummary' ? null : id;
  return (
    <section
      data-section={id}
      onClick={onClick}
      className={cn(
        'group scroll-mt-20 rounded-md px-3 py-2 transition-colors',
        '-mx-3',
        highlighted && 'ring-1 ring-amber-500/30',
        emphasized && 'bg-amber-500/5 ring-2 ring-amber-500/40',
        onClick && 'cursor-pointer hover:bg-muted/30',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          <span className="text-muted-foreground">{number}.</span> {title}
        </h2>
        {reportId && refineSection && (
          <div
            // Edit affordance is permanently visible per section (was
            // hover-only) so coaches can see at a glance that every
            // section is editable.
            onClick={(e) => e.stopPropagation()}
          >
            <RefineSectionPopover reportId={reportId} section={refineSection} />
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

function formatPeriod(start?: string | null, end?: string | null): string {
  if (!start && !end) return '';
  const s = start ? new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const e = end ? new Date(end).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return s && e ? `${s} – ${e}` : s || e;
}
