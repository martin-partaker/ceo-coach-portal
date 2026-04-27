'use client';

import { Mail, FileText, Video, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface TriageSuggestionView {
  ceoId: string;
  ceoName: string;
  ceoEmail: string | null;
  coachName: string;
  confidence: number;
  reasoning: string;
}

export interface TriageCardData {
  rawInputId: string;
  source: string;
  contentType: string;
  occurredAt: Date | string;
  coachName: string | null;
  submitterEmail: string | null;
  submitterName: string | null;
  textSnippet: string;
  meetingTopic: string | null;
  participantsSummary: string | null;
  matchStatus: string;
  topSuggestion: TriageSuggestionView | null;
  alternatives: TriageSuggestionView[];
}

const CONTENT_TYPE_LABEL: Record<string, string> = {
  weekly_journal: 'Weekly journal',
  monthly_journal: 'Monthly journal',
  goal_worksheet: '10x goal worksheet',
  intake: 'Intake survey',
  self_assessment: 'Self-assessment',
  support_feedback: 'Support feedback',
  transcript: 'Transcript',
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

function highlightDiff(a: string, b: string): { aMarked: string; bMarked: string } {
  // Very simple char-level diff: surround diverging substrings with []
  // Used inline as a hint to the eye, not a real diff renderer.
  if (!a || !b) return { aMarked: a, bMarked: b };
  const minLen = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  if (prefix === a.length && prefix === b.length) {
    return { aMarked: a, bMarked: b };
  }
  return {
    aMarked:
      a.slice(0, prefix) +
      '«' +
      a.slice(prefix, a.length - suffix) +
      '»' +
      a.slice(a.length - suffix),
    bMarked:
      b.slice(0, prefix) +
      '«' +
      b.slice(prefix, b.length - suffix) +
      '»' +
      b.slice(b.length - suffix),
  };
}

export function TriageCard({ data }: { data: TriageCardData }) {
  const SourceIcon = sourceIcon(data.source);
  const occurred = new Date(data.occurredAt);
  const dateStr = occurred.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const top = data.topSuggestion;
  const tier = top ? confidenceTier(top.confidence) : 'low';
  const tc = tierClasses(tier);

  // Email diff highlighting when both emails present
  let submitterEmailMarked = data.submitterEmail ?? '';
  let suggestionEmailMarked = top?.ceoEmail ?? '';
  if (data.submitterEmail && top?.ceoEmail && data.submitterEmail !== top.ceoEmail) {
    const m = highlightDiff(data.submitterEmail, top.ceoEmail);
    submitterEmailMarked = m.aMarked;
    suggestionEmailMarked = m.bMarked;
  }

  const initials = top
    ? top.ceoName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? '')
        .join('')
    : '';

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            What we received
          </span>
          <Badge variant="outline" className="gap-1.5 font-normal">
            <SourceIcon className="h-3 w-3" />
            {CONTENT_TYPE_LABEL[data.contentType] ?? data.contentType}
          </Badge>
          <span className="font-mono text-muted-foreground">{dateStr}</span>
        </div>
        {data.coachName && (
          <span className="text-xs text-muted-foreground">
            for coach <span className="text-foreground">{data.coachName}</span>
          </span>
        )}
      </div>

      {/* Source block — submission content */}
      <div className="space-y-4 bg-muted/20 px-5 py-4">
        {data.meetingTopic && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Meeting topic
            </p>
            <p className="mt-1 text-sm">{data.meetingTopic}</p>
          </div>
        )}

        <div>
          {data.textSnippet && (
            <p className="text-sm leading-relaxed text-foreground/90 line-clamp-4">
              {data.textSnippet}
              {data.textSnippet.length >= 590 && (
                <span className="text-muted-foreground"> …</span>
              )}
            </p>
          )}
        </div>

        {(data.submitterEmail || data.submitterName || data.participantsSummary) && (
          <div className="rounded-lg border border-border/80 bg-background px-3 py-2.5 text-xs">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {data.source === 'zoom' ? 'Participants · as recorded' : 'From submitter · as recorded'}
            </p>
            {data.submitterEmail && (
              <div className="flex gap-3 font-mono">
                <span className="w-12 shrink-0 text-muted-foreground">EMAIL</span>
                <span className="break-all">{submitterEmailMarked}</span>
              </div>
            )}
            {data.submitterName && (
              <div className="flex gap-3">
                <span className="w-12 shrink-0 font-mono text-muted-foreground">NAME</span>
                <span>{data.submitterName}</span>
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

      {/* AI proposal block */}
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            AI proposes
          </p>
          {top && (
            <div className="flex items-center gap-2">
              <span className={cn('text-xs font-medium', tc.label)}>{tierLabel(tier)}</span>
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full transition-all', tc.bar)}
                  style={{ width: `${top.confidence}%` }}
                />
              </div>
              <span className="w-9 text-right text-xs font-mono tabular-nums text-muted-foreground">
                {top.confidence}%
              </span>
            </div>
          )}
        </div>

        {top ? (
          <div className={cn('rounded-lg border p-3', tc.box)}>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-200/40 text-sm font-semibold text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-semibold">{top.ceoName}</p>
                  {top.ceoEmail && (
                    <span className="break-all font-mono text-xs text-muted-foreground">
                      {suggestionEmailMarked}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Coached by {top.coachName}
                </p>
                <p className="mt-2 border-t border-border/40 pt-2 text-xs text-muted-foreground">
                  <span className="text-foreground/70">Why:</span> {top.reasoning}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center">
            <p className="text-sm text-muted-foreground">
              No clear suggestion. Use{' '}
              <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">
                Tab
              </kbd>{' '}
              to pick a CEO.
            </p>
          </div>
        )}

        {/* Alternatives */}
        {data.alternatives.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Or one of these
            </p>
            {data.alternatives.map((alt, i) => {
              const altTier = confidenceTier(alt.confidence);
              const atc = tierClasses(altTier);
              return (
                <div
                  key={alt.ceoId}
                  className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-1.5 text-xs"
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
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
