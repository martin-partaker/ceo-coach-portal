'use client';

import { Mail, FileText, Video, Pencil, Sparkles, Undo2, Plus, X } from 'lucide-react';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { cn } from '@/lib/utils';

export interface TriageSuggestionView {
  ceoId: string;
  ceoName: string;
  ceoEmail: string | null;
  ceoAvatarUrl: string | null;
  /** Null when the suggested CEO is in the Unassigned bucket. */
  coachName: string | null;
  /** Numeric score (legacy). The simplified card no longer surfaces it. */
  confidence: number;
  reasoning: string;
}

export interface TriageCycleSuggestionView {
  cycleId: string;
  cycleLabel: string;
  confident: boolean;
}

export interface ClassifierVerdict {
  meetingType?: string;
  includeInMonthlySummary?: boolean;
  includeReason?: string;
}

export interface TriageCardData {
  rawInputId: string;
  source: string;
  contentType: string;
  occurredAt: Date | string;
  coachName: string | null;
  submitterEmail: string | null;
  submitterName: string | null;
  submittedByCoach: { email: string; name: string | null } | null;
  textSnippet: string;
  meetingTopic: string | null;
  participantsSummary: string | null;
  matchStatus: string;
  /** Kept on the type for parity with the server response — the
   *  simplified card no longer renders it as a separate block. */
  classification?: ClassifierVerdict | null;
  topSuggestion: TriageSuggestionView | null;
  alternatives: TriageSuggestionView[];
  /** Cycle suggestion is only shown when the row is `pending_cycle` — i.e.
   *  the CEO is already known and we need a target cycle. */
  cycleSuggestion: TriageCycleSuggestionView | null;
}

const CONTENT_TYPE_LABEL: Record<string, string> = {
  weekly_journal: 'Weekly journal',
  monthly_journal: 'Monthly journal',
  goal_worksheet: '10x goal worksheet',
  intake: 'Intake survey',
  self_assessment: 'Self-assessment',
  support_feedback: 'Support feedback',
  transcript: 'Zoom transcript',
  coach_note: 'Coach note',
  fallback_doc: 'Fallback doc',
  unknown: 'Unknown',
};

function sourceIcon(source: string) {
  if (source === 'zoom') return Video;
  if (source === 'tally') return FileText;
  return Mail;
}

export interface TriageCardProps {
  data: TriageCardData;
  onPickAlternative?: (ceoId: string, ceoName: string) => void;
  onPickCeoClick?: () => void;
  onChangeClick?: () => void;
  /** When the operator has overridden the AI's pick we render the chosen
   *  CEO in amber and offer a revert affordance back to the original. */
  proposalLabel?: string;
  proposalToneOverride?: 'manual';
  previousAiSuggestion?: TriageSuggestionView | null;
  onRevertToAi?: () => void;
  /** Extra CEOs picked alongside the primary (`data.topSuggestion` is the
   *  primary). Rendered as compact chips below the primary card. */
  additionalPicks?: TriageSuggestionView[];
  /** Called when the operator clicks the X on a chip — both the primary
   *  match card (when manual) and any additional pick chip. */
  onRemovePick?: (ceoId: string) => void;
  /** Renders a "+ Add another CEO" button below the match block. Used by
   *  the triage walkthrough to support multi-CEO assignment. */
  onAddAnotherClick?: () => void;
}

/**
 * Triage card — minimal-cognitive-load redesign.
 *
 * Pure intent: match this piece of content to a CEO. We removed the
 * percentage bars, tier classes, classifier verdict block, evidence
 * pills, and email-diff renderer because they were noise on top of a
 * simple yes/no decision. What's left, top-to-bottom:
 *
 *   1. WHAT this is — content type + date + (optionally) coach context.
 *   2. WHO it came from — submitter email/name and (Zoom) participants
 *      in a single compact box.
 *   3. THE CONTENT — short snippet, scrollable.
 *   4. THE MATCH — one CEO, one short reason in plain English. The AI
 *      reason replaces every numeric/coloured signal we used to ship.
 *   5. ALTERNATIVES — same shape, smaller, only when the model is
 *      genuinely unsure.
 */
export function TriageCard({
  data,
  onPickAlternative,
  onPickCeoClick,
  onChangeClick,
  proposalLabel,
  proposalToneOverride,
  previousAiSuggestion,
  onRevertToAi,
  additionalPicks,
  onRemovePick,
  onAddAnotherClick,
}: TriageCardProps) {
  const SourceIcon = sourceIcon(data.source);
  const occurred = new Date(data.occurredAt);
  const dateStr = occurred.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const top = data.topSuggestion;
  const isManual = proposalToneOverride === 'manual';

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      {/* Header — what this is */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
            <SourceIcon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-base font-semibold leading-tight">
              {CONTENT_TYPE_LABEL[data.contentType] ?? data.contentType}
            </p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{dateStr}</span>
              {data.source && (
                <span className="ml-2 uppercase tracking-wider">{data.source}</span>
              )}
            </p>
          </div>
        </div>
        {data.coachName && (
          <span className="text-xs text-muted-foreground">
            for coach <span className="text-foreground">{data.coachName}</span>
          </span>
        )}
      </div>

      {/* Source + content */}
      <div className="space-y-3 bg-muted/15 px-5 py-4">
        <SubmitterBlock data={data} />

        {data.meetingTopic && (
          <p className="text-xs">
            <span className="font-mono uppercase tracking-wider text-muted-foreground">
              Topic ·{' '}
            </span>
            <span className="text-foreground/90">{data.meetingTopic}</span>
          </p>
        )}

        {data.textSnippet && (
          <div className="max-h-44 overflow-y-auto rounded-lg border border-border/40 bg-background/60 px-3 py-2.5">
            <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground/90">
              {data.textSnippet}
            </pre>
          </div>
        )}
      </div>

      {/* Match block */}
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles
            className={cn(
              'h-3.5 w-3.5',
              isManual ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
            )}
          />
          <p
            className={cn(
              'text-[10px] font-medium uppercase tracking-wider',
              isManual ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
            )}
          >
            {proposalLabel ?? (top ? 'AI match' : 'No clear match')}
          </p>
          {onChangeClick && (
            <button
              type="button"
              onClick={onChangeClick}
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              <Pencil className="h-2.5 w-2.5" />
              {isManual ? 'change pick' : 'pick another'}
            </button>
          )}
        </div>

        {top ? (
          <MatchCard
            suggestion={top}
            isManual={isManual}
            cycleSuggestion={data.cycleSuggestion}
            onRemove={
              isManual && onRemovePick ? () => onRemovePick(top.ceoId) : undefined
            }
          />
        ) : (
          <button
            type="button"
            onClick={onPickCeoClick}
            disabled={!onPickCeoClick}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-3 text-left transition-colors hover:border-foreground/40 hover:bg-muted/40 disabled:cursor-default"
          >
            <span className="text-sm text-muted-foreground">
              Couldn&apos;t identify a CEO from this content.
            </span>
            <span className="text-[12px] font-medium text-foreground underline-offset-4 hover:underline">
              Pick a CEO →
            </span>
          </button>
        )}

        {/* Additional picks — chips below the primary match card. Only
            rendered when the operator has explicitly added more CEOs via
            "+ Add another CEO". */}
        {additionalPicks && additionalPicks.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {additionalPicks.map((pick) => (
              <span
                key={pick.ceoId}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/[0.08] py-1 pl-2 pr-1 text-xs"
              >
                <CeoAvatar
                  name={pick.ceoName}
                  avatarUrl={pick.ceoAvatarUrl}
                  size="sm"
                />
                <span className="font-medium text-foreground">{pick.ceoName}</span>
                {pick.coachName && (
                  <span className="text-muted-foreground">· {pick.coachName}</span>
                )}
                {onRemovePick && (
                  <button
                    type="button"
                    onClick={() => onRemovePick(pick.ceoId)}
                    aria-label={`Remove ${pick.ceoName}`}
                    className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-amber-500/20 hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {/* "+ Add another CEO" — surfaced when the walkthrough is in pick
            mode (top exists, either AI or manual). Lets the operator
            attach a transcript to multiple CEOs (e.g. group sessions or
            two-CEO kickoffs). */}
        {top && onAddAnotherClick && (
          <button
            type="button"
            onClick={onAddAnotherClick}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-background px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Add another CEO
          </button>
        )}

        {/* Revert-to-AI affordance — only in manual override mode */}
        {isManual && previousAiSuggestion && onRevertToAi && (
          <button
            type="button"
            onClick={onRevertToAi}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Undo2 className="h-3 w-3" />
            Revert to AI suggestion: {previousAiSuggestion.ceoName}
          </button>
        )}

        {/* Alternatives — minimal, only if the model offered any */}
        {!isManual && data.alternatives.length > 0 && (
          <div className="mt-3 space-y-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Or maybe
            </p>
            {data.alternatives.map((alt) => (
              <button
                key={alt.ceoId}
                type="button"
                onClick={() => onPickAlternative?.(alt.ceoId, alt.ceoName)}
                disabled={!onPickAlternative}
                className="group flex w-full items-start gap-2.5 rounded-md border border-border/60 px-3 py-2 text-left text-xs transition-colors hover:border-foreground/40 hover:bg-muted/40 disabled:cursor-default"
              >
                <CeoAvatar name={alt.ceoName} avatarUrl={alt.ceoAvatarUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-foreground">{alt.ceoName}</span>
                    {alt.coachName && (
                      <span className="text-[11px] text-muted-foreground">· {alt.coachName}</span>
                    )}
                  </div>
                  {alt.reasoning && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{alt.reasoning}</p>
                  )}
                </div>
                <span className="hidden shrink-0 self-center text-[10px] text-muted-foreground/70 group-hover:inline">
                  pick →
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact source/submitter block. Coach-authored Tally submissions get
 * a single-line callout so the operator instantly sees the actual
 * subject is the CEO named in the form, not the @partaker.com sender.
 */
function SubmitterBlock({ data }: { data: TriageCardData }) {
  const hasContent =
    data.submittedByCoach ||
    data.submitterEmail ||
    data.submitterName ||
    data.participantsSummary;
  if (!hasContent) return null;

  return (
    <div className="space-y-1 rounded-lg border border-border/80 bg-background px-3 py-2 text-[12px]">
      {data.submittedByCoach && (
        <p className="text-[11.5px]">
          <span className="mr-1.5 inline-flex items-center rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-purple-700 dark:text-purple-300">
            coach-authored
          </span>
          Submitted by{' '}
          <span className="font-medium">
            {data.submittedByCoach.name ?? data.submittedByCoach.email}
          </span>
          {data.submitterName && (
            <>
              {' '}about{' '}
              <span className="font-medium">{data.submitterName}</span>
            </>
          )}
        </p>
      )}
      {!data.submittedByCoach && data.submitterEmail && (
        <p className="flex gap-3">
          <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            From
          </span>
          <span className="font-mono text-[12px]">{data.submitterEmail}</span>
        </p>
      )}
      {data.submitterName && !data.submittedByCoach && (
        <p className="flex gap-3">
          <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Name
          </span>
          <span>{data.submitterName}</span>
        </p>
      )}
      {data.participantsSummary && (
        <p className="flex gap-3">
          <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            People
          </span>
          <span>{data.participantsSummary}</span>
        </p>
      )}
    </div>
  );
}

function MatchCard({
  suggestion,
  isManual,
  cycleSuggestion,
  onRemove,
}: {
  suggestion: TriageSuggestionView;
  isManual: boolean;
  cycleSuggestion: TriageCycleSuggestionView | null;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        isManual
          ? 'border-amber-500/40 bg-amber-500/[0.04]'
          : 'border-border bg-background'
      )}
    >
      <div className="flex items-start gap-3">
        <CeoAvatar
          name={suggestion.ceoName}
          avatarUrl={suggestion.ceoAvatarUrl}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="text-sm font-semibold">{suggestion.ceoName}</p>
            {suggestion.ceoEmail && (
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {suggestion.ceoEmail}
              </span>
            )}
          </div>
          {suggestion.coachName && (
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Coached by {suggestion.coachName}
            </p>
          )}
          {suggestion.reasoning && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-foreground/85">
              {suggestion.reasoning}
            </p>
          )}
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${suggestion.ceoName}`}
            className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-amber-500/20 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Cycle preview only matters when the row is pending_cycle (CEO
          known, cycle not). For the normal CEO-match path we skip it —
          the cycle is handled at confirm-time by the server. */}
      {cycleSuggestion && (
        <div className="mt-2.5 flex items-center gap-2 border-t border-border/40 pt-2.5 text-[11.5px]">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Suggested cycle
          </span>
          <span className="font-medium">{cycleSuggestion.cycleLabel}</span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px]',
              cycleSuggestion.confident
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
            )}
          >
            {cycleSuggestion.confident ? 'date in period' : 'fallback'}
          </span>
        </div>
      )}
    </div>
  );
}
