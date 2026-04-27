'use client';

import { Mail, FileText, Video, Users, Check, X, AlertCircle, FileQuestion, MousePointerClick, Pencil, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { cn } from '@/lib/utils';

export interface TriageSuggestionView {
  ceoId: string;
  ceoName: string;
  ceoEmail: string | null;
  ceoAvatarUrl: string | null;
  coachName: string;
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
  classification?: ClassifierVerdict | null;
  topSuggestion: TriageSuggestionView | null;
  alternatives: TriageSuggestionView[];
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

function confidenceTier(score: number): 'high' | 'medium' | 'low' {
  if (score >= 95) return 'high';
  if (score >= 70) return 'medium';
  return 'low';
}

function tierClasses(tier: 'high' | 'medium' | 'low') {
  if (tier === 'high') {
    return {
      bar: 'bg-emerald-500',
      label: 'text-emerald-700 dark:text-emerald-400',
      box: 'border-emerald-500/30 bg-emerald-500/[0.04]',
    };
  }
  if (tier === 'medium') {
    return {
      bar: 'bg-amber-500',
      label: 'text-amber-700 dark:text-amber-400',
      box: 'border-amber-500/30 bg-amber-500/[0.04]',
    };
  }
  return {
    bar: 'bg-red-500',
    label: 'text-red-700 dark:text-red-400',
    box: 'border-red-500/30 bg-red-500/[0.04]',
  };
}

function tierLabel(tier: 'high' | 'medium' | 'low'): string {
  if (tier === 'high') return 'Strong match';
  if (tier === 'medium') return 'Likely match';
  return 'Weak match';
}

/**
 * Character-level diff renderer. Returns a JSX span where matching characters
 * are normal weight and divergent ones are highlighted. Used to make the
 * email comparison instantly visual.
 */
function DiffEmail({
  shown,
  other,
  variant = 'submitted',
}: {
  shown: string;
  other: string | null;
  variant?: 'submitted' | 'suggested';
}) {
  if (!other || shown === other) {
    return <span className="font-mono">{shown}</span>;
  }

  const minLen = Math.min(shown.length, other.length);
  let prefix = 0;
  while (prefix < minLen && shown[prefix] === other[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    shown[shown.length - 1 - suffix] === other[other.length - 1 - suffix]
  )
    suffix++;

  const before = shown.slice(0, prefix);
  const middle = shown.slice(prefix, shown.length - suffix);
  const after = shown.slice(shown.length - suffix);

  const highlightClass =
    variant === 'submitted'
      ? 'rounded bg-red-500/15 px-0.5 text-red-700 dark:text-red-400'
      : 'rounded bg-emerald-500/15 px-0.5 text-emerald-700 dark:text-emerald-400';

  return (
    <span className="font-mono">
      {before}
      {middle && <span className={highlightClass}>{middle}</span>}
      {after}
    </span>
  );
}

function normalizeForMatch(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.,;:!?_'"`()\[\]{}<>\/\\|@#&*+=~^-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * Build the evidence pills for the AI proposes block — concrete, scannable
 * indicators of what matches and what's missing. Designed to NOT cry wolf:
 * if the submitter didn't include an email, we don't flag that as a warning
 * — the name match speaks for itself.
 */
function buildEvidencePills(args: {
  submitterEmail: string | null;
  submitterName: string | null;
  suggestionEmail: string | null;
  suggestionName: string;
  matchStatus: string;
  cycleSuggestion: TriageCycleSuggestionView | null;
  occurredAt: Date;
}): Array<{ label: string; tone: 'ok' | 'warn' | 'fail' }> {
  const out: Array<{ label: string; tone: 'ok' | 'warn' | 'fail' }> = [];
  const { submitterEmail, suggestionEmail, submitterName, suggestionName } = args;

  // Email evidence — only show pills when the submitter actually provided an email.
  // "No email submitted" is not a warning; it's just absence of one signal.
  if (submitterEmail) {
    if (suggestionEmail) {
      if (submitterEmail === suggestionEmail) {
        out.push({ label: 'Email exact match', tone: 'ok' });
      } else {
        const [sLocal, sDomain] = submitterEmail.split('@');
        const [aLocal, aDomain] = suggestionEmail.split('@');
        if (sLocal === aLocal && sDomain !== aDomain) {
          out.push({ label: `Domain typo: ${sDomain} → ${aDomain}`, tone: 'warn' });
        } else if (sDomain === aDomain && sLocal !== aLocal) {
          out.push({ label: 'Same domain · different address', tone: 'warn' });
        } else {
          out.push({ label: 'Email similar', tone: 'warn' });
        }
      }
    } else {
      out.push({ label: 'No email on CEO record', tone: 'warn' });
    }
  }

  // Name evidence — granular: separate first-name and last-name pills so the
  // operator sees "first name matches · last name typo" instead of an opaque
  // "name similar" verdict.
  if (submitterName && suggestionName) {
    const subTokens = normalizeForMatch(submitterName).split(' ').filter(Boolean);
    const sugTokens = normalizeForMatch(suggestionName).split(' ').filter(Boolean);
    const subFirst = subTokens[0] ?? '';
    const sugFirst = sugTokens[0] ?? '';
    const subLast = subTokens[subTokens.length - 1] ?? '';
    const sugLast = sugTokens[sugTokens.length - 1] ?? '';

    if (subTokens.join(' ') === sugTokens.join(' ')) {
      out.push({ label: 'Names match', tone: 'ok' });
    } else {
      // First name
      if (subFirst && sugFirst) {
        if (subFirst === sugFirst) {
          out.push({ label: 'First name matches', tone: 'ok' });
        } else {
          const r = levRatio(subFirst, sugFirst);
          if (r >= 0.7) {
            out.push({ label: `First name typo: ${subFirst} → ${sugFirst}`, tone: 'warn' });
          }
        }
      }

      // Last name (only if both have ≥2 tokens)
      if (subTokens.length >= 2 && sugTokens.length >= 2 && subLast && sugLast) {
        if (subLast === sugLast) {
          out.push({ label: 'Last name matches', tone: 'ok' });
        } else {
          const r = levRatio(subLast, sugLast);
          if (r >= 0.7) {
            out.push({ label: `Last name typo: ${subLast} → ${sugLast}`, tone: 'warn' });
          } else if (r >= 0.4) {
            out.push({ label: `Different last name: "${subLast}" vs "${sugLast}"`, tone: 'warn' });
          }
        }
      } else if (subTokens.length === 1 || sugTokens.length === 1) {
        // Only first names available on one side
        out.push({ label: 'Single name only — partial info', tone: 'warn' });
      }
    }
  }

  // Cycle evidence intentionally omitted — handled by the dedicated
  // "Suggested cycle" panel below, and not actionable from these pills anyway.

  return out;
}

function PillIcon({ tone }: { tone: 'ok' | 'warn' | 'fail' }) {
  if (tone === 'ok') return <Check className="h-3 w-3" />;
  if (tone === 'warn') return <AlertCircle className="h-3 w-3" />;
  return <X className="h-3 w-3" />;
}

function pillClasses(tone: 'ok' | 'warn' | 'fail'): string {
  if (tone === 'ok')
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (tone === 'warn')
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400';
}

export interface TriageCardProps {
  data: TriageCardData;
  /** Called when an alternative is clicked. */
  onPickAlternative?: (ceoId: string, ceoName: string) => void;
  /** Called when the operator clicks the empty-state "pick a CEO" CTA. */
  onPickCeoClick?: () => void;
  /** Called when the operator clicks the always-visible "Change" affordance. */
  onChangeClick?: () => void;
  /** Override the section header label (e.g. "You picked" instead of "AI proposes"). */
  proposalLabel?: string;
  /** Visual tone override — 'manual' renders in amber to distinguish operator picks. */
  proposalToneOverride?: 'manual';
  /** When in manual-pick mode, the AI's original suggestion to allow reverting. */
  previousAiSuggestion?: TriageSuggestionView | null;
  /** Called when the operator clicks "Revert to AI suggestion". */
  onRevertToAi?: () => void;
}

export function TriageCard({
  data,
  onPickAlternative,
  onPickCeoClick,
  onChangeClick,
  proposalLabel,
  proposalToneOverride,
  previousAiSuggestion,
  onRevertToAi,
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
  const tier = top ? confidenceTier(top.confidence) : 'low';
  const tc = isManual
    ? {
        bar: 'bg-amber-500',
        label: 'text-amber-700 dark:text-amber-400',
        box: 'border-amber-500/40 bg-amber-500/[0.05] ring-1 ring-amber-500/20',
      }
    : tierClasses(tier);

  const evidencePills = buildEvidencePills({
    submitterEmail: data.submitterEmail,
    submitterName: data.submitterName,
    suggestionEmail: top?.ceoEmail ?? null,
    suggestionName: top?.ceoName ?? '',
    matchStatus: data.matchStatus,
    cycleSuggestion: data.cycleSuggestion,
    occurredAt: occurred,
  });

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      {/* Prominent header: document type is the headline */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
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
              {data.source && <span className="ml-2 uppercase tracking-wider">{data.source}</span>}
            </p>
          </div>
        </div>
        {data.coachName && (
          <span className="text-xs text-muted-foreground">
            for coach <span className="text-foreground">{data.coachName}</span>
          </span>
        )}
      </div>

      {/* Source block */}
      <div className="space-y-4 bg-muted/20 px-5 py-4">
        {data.meetingTopic && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Meeting topic
            </p>
            <p className="mt-1 text-sm">{data.meetingTopic}</p>
          </div>
        )}

        {data.textSnippet && (
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border/40 bg-background/60 px-3 py-2.5">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">
              {data.textSnippet}
            </pre>
          </div>
        )}

        {(data.submitterEmail ||
          data.submitterName ||
          data.participantsSummary ||
          data.submittedByCoach) && (
          <div className="rounded-lg border border-border/80 bg-background px-3 py-2.5 text-xs">
            {/* Coach-submitted framing — when @partaker.com filled the form on
                behalf of a CEO, surface that as the headline so the operator
                knows the actual subject is the client name field. */}
            {data.submittedByCoach && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-purple-500/30 bg-purple-500/[0.06] px-2 py-1.5 text-[11px]">
                <span className="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-purple-700 dark:text-purple-300">
                  coach-authored
                </span>
                <span>
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
                </span>
              </div>
            )}

            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {data.source === 'zoom'
                ? 'Participants · as recorded'
                : data.submittedByCoach
                  ? 'Client (as named on the form)'
                  : 'From submitter · as recorded'}
            </p>
            {data.submitterEmail && !data.submittedByCoach && (
              <div className="flex gap-3">
                <span className="w-12 shrink-0 font-mono text-muted-foreground">EMAIL</span>
                <DiffEmail
                  shown={data.submitterEmail}
                  other={top?.ceoEmail ?? null}
                  variant="submitted"
                />
              </div>
            )}
            {data.submitterName && (
              <div className="flex gap-3">
                <span className="w-12 shrink-0 font-mono text-muted-foreground">NAME</span>
                <span>{data.submitterName}</span>
              </div>
            )}
            {data.submittedByCoach && (
              <div className="mt-1 flex gap-3 text-muted-foreground">
                <span className="w-12 shrink-0 font-mono">COACH</span>
                <span className="font-mono">{data.submittedByCoach.email}</span>
              </div>
            )}
            {data.participantsSummary && (
              <div className="flex gap-3">
                <span className="w-12 shrink-0 font-mono text-muted-foreground">PEOPLE</span>
                <span>{data.participantsSummary}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Classifier verdict — what kind of meeting AI thinks this is, sits
          right above the AI Proposes block so the narrative reads:
          source → AI's take → AI's CEO suggestion. Operator-overridable. */}
      {data.source === 'zoom' && data.classification && (
        <div
          className={cn(
            'border-t border-border px-5 py-2.5 text-xs',
            data.classification.includeInMonthlySummary
              ? 'bg-emerald-500/[0.06]'
              : 'bg-amber-500/[0.06]'
          )}
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0',
                data.classification.includeInMonthlySummary
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              )}
            />
            <div className="flex-1">
              <p
                className={cn(
                  'font-medium',
                  data.classification.includeInMonthlySummary
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-amber-700 dark:text-amber-300'
                )}
              >
                AI reasoning:{' '}
                <span className="font-mono">
                  {data.classification.meetingType ?? 'unclassified'}
                </span>
                {' · '}
                {data.classification.includeInMonthlySummary
                  ? 'include in summary'
                  : 'likely archive / discard'}
              </p>
              {data.classification.includeReason && (
                <p className="mt-0.5 text-muted-foreground">
                  {data.classification.includeReason}
                </p>
              )}
              <p className="mt-0.5 text-[10px] text-muted-foreground/80">
                You decide — confirm a CEO match, archive, or discard.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* AI proposal */}
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p
              className={cn(
                'text-[10px] font-medium uppercase tracking-wider',
                isManual ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
              )}
            >
              {proposalLabel ?? 'AI proposes'}
            </p>
            {onChangeClick && (
              <button
                type="button"
                onClick={onChangeClick}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
              >
                <Pencil className="h-2.5 w-2.5" />
                {isManual ? 'change pick' : 'pick another'}
              </button>
            )}
          </div>
          {top && !isManual && (
            <div className="flex items-center gap-2">
              <span className={cn('text-xs font-medium', tc.label)}>{tierLabel(tier)}</span>
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full transition-all', tc.bar)}
                  style={{ width: `${top.confidence}%` }}
                />
              </div>
              <span className="w-9 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {top.confidence}%
              </span>
            </div>
          )}
          {isManual && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              Manual override
            </span>
          )}
        </div>

        {top ? (
          <div className={cn('rounded-lg border p-3', tc.box)}>
            <div className="flex items-start gap-3">
              <CeoAvatar name={top.ceoName} avatarUrl={top.ceoAvatarUrl} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <p className="text-sm font-semibold">{top.ceoName}</p>
                  {top.ceoEmail && (
                    <span className="text-xs text-muted-foreground">
                      <DiffEmail
                        shown={top.ceoEmail}
                        other={data.submitterEmail}
                        variant="suggested"
                      />
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Coached by {top.coachName}
                </p>
              </div>
            </div>

            {/* Evidence pills — what matches and what's missing */}
            {evidencePills.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/40 pt-3">
                {evidencePills.map((p, i) => (
                  <span
                    key={i}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                      pillClasses(p.tone)
                    )}
                  >
                    <PillIcon tone={p.tone} />
                    {p.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={onPickCeoClick}
            disabled={!onPickCeoClick}
            className="group flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-5 transition-colors hover:border-foreground/40 hover:bg-muted/40 disabled:cursor-default disabled:hover:border-border disabled:hover:bg-muted/20"
          >
            <FileQuestion className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              No clear suggestion —{' '}
              <span className="text-foreground underline-offset-4 group-hover:underline">
                pick a CEO
              </span>
            </span>
            <MousePointerClick className="h-3.5 w-3.5 text-muted-foreground/70" />
            <span className="ml-1 text-[10px] text-muted-foreground/70">
              or press{' '}
              <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">
                Tab
              </kbd>
            </span>
          </button>
        )}

        {/* Revert-to-AI affordance — only shown when in manual override mode */}
        {isManual && previousAiSuggestion && onRevertToAi && (
          <button
            type="button"
            onClick={onRevertToAi}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Undo2 className="h-3 w-3" />
            Revert to AI suggestion: {previousAiSuggestion.ceoName}
            <span className="text-muted-foreground/70">({previousAiSuggestion.confidence}%)</span>
          </button>
        )}

        {/* Cycle suggestion */}
        {data.cycleSuggestion && top && (
          <div className="mt-3 flex items-center gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Suggested cycle
            </span>
            <span className="font-medium">{data.cycleSuggestion.cycleLabel}</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px]',
                data.cycleSuggestion.confident
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
              )}
            >
              {data.cycleSuggestion.confident
                ? 'date in period'
                : 'fallback (date outside period)'}
            </span>
          </div>
        )}

        {/* Alternatives — clickable */}
        {data.alternatives.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Or pick one of these
            </p>
            {data.alternatives.map((alt, i) => {
              const altTier = confidenceTier(alt.confidence);
              const atc = tierClasses(altTier);
              return (
                <button
                  key={alt.ceoId}
                  type="button"
                  onClick={() => onPickAlternative?.(alt.ceoId, alt.ceoName)}
                  disabled={!onPickAlternative}
                  className="group flex w-full items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-left text-xs transition-colors hover:border-foreground/40 hover:bg-muted/40 disabled:cursor-default disabled:hover:border-border/60 disabled:hover:bg-transparent"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] tabular-nums text-muted-foreground">
                    {i + 2}
                  </span>
                  <Users className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{alt.ceoName}</span>
                  <span className="truncate text-muted-foreground">· {alt.coachName}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="h-1 w-12 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full', atc.bar)} style={{ width: `${alt.confidence}%` }} />
                    </div>
                    <span className="w-8 text-right font-mono tabular-nums text-muted-foreground">
                      {alt.confidence}%
                    </span>
                    <span className="hidden text-[10px] text-muted-foreground/70 group-hover:inline">
                      click to pick →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
