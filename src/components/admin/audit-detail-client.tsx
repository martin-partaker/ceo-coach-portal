'use client';

import Link from 'next/link';
import { ArrowLeft, Loader2, AlertTriangle, Info } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  ConfidenceBadge,
  Pill,
  VERDICT_TONE,
  formatClock,
} from './audit-confidence';

const FAMILY_LABEL: Record<string, { title: string; blurb: string }> = {
  A: {
    title: 'A. Process — did each outline step happen?',
    blurb:
      'The outline step by step, in the outline’s own numbering and order, so it ' +
      'lines up with the script the coaches work from. A step that is missing or ' +
      'out of order is an observation here, never a finding on its own.',
  },
  B: {
    title: 'B. Substance — was each step done adequately and correctly?',
    blurb:
      'Coverage says a step happened. These test whether it was done well enough.',
  },
  C: {
    title: 'C. Craft — the Coaching Standards',
    blurb:
      'Only the standards a transcript can actually show. The rest are named as ' +
      'unassessed rather than passed over.',
  },
  D: {
    title: 'D. Preparation — did the coach use what the CEO sent?',
    blurb:
      'Against the Intake Survey and the 10x Goal Worksheet, filed before the session.',
  },
};

const BASIS_LABEL: Record<string, string> = {
  source: 'from a ScaleOS document',
  documented: 'named by Lauren and/or Megan',
  proposed: 'our proposal',
};

export function AuditDetailClient({ auditId }: { auditId: string }) {
  const { data, isLoading, error } = trpc.audit.byId.useQuery({ auditId });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Not found.</p>;

  if (data.state !== 'ok') {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card className="border-l-4 border-l-amber-500 bg-amber-500/5 p-4">
          <p className="flex gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{data.reason}</span>
          </p>
        </Card>
      </div>
    );
  }

  const { audit, transcript } = data;
  const families = ['A', 'B', 'C', 'D'];

  return (
    <div className="space-y-6">
      <BackLink />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {transcript.title ?? 'Untitled recording'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ConfidenceBadge value={audit.confidence} />
          {audit.coachLabel ? (
            <span className="text-sm text-muted-foreground">
              {audit.coachLabel}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            criteria {audit.criteriaVersion}
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          {audit.confidenceReason}
        </p>
        {!transcript.hasCueTimes ? (
          <p className="mt-2 flex max-w-3xl gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              No cue times were captured for this recording, so quotes below show
              the words but cannot point at a moment in the call.
            </span>
          </p>
        ) : null}
      </div>

      {families.map((fam) => {
        const examined = audit.familiesExamined.includes(
          fam as 'A' | 'B' | 'C' | 'D',
        );
        const items = audit.findings.filter((f) => f.family === fam);
        const meta = FAMILY_LABEL[fam];

        return (
          <section key={fam} className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">{meta.title}</h2>
              <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
                {meta.blurb}
              </p>
            </div>

            {/* The distinction this whole section exists to protect: a family
                with nothing in it is only good news if it was looked at. */}
            {!examined ? (
              <Card className="border-l-4 border-l-amber-500 bg-amber-500/5 p-4">
                <p className="flex gap-2 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>
                    <strong>Not examined.</strong> This family was not run for
                    this session, so an empty list here means nothing was
                    looked at — not that nothing was wrong.
                  </span>
                </p>
              </Card>
            ) : items.length === 0 ? (
              <Card className="p-4">
                <p className="text-sm text-muted-foreground">
                  Examined, nothing raised.
                </p>
              </Card>
            ) : (
              <div className="space-y-2">
                {items.map((f) => (
                  <Finding key={`${f.id}-${f.step ?? ''}`} f={f} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/audit"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> All sessions
    </Link>
  );
}

type FindingShape = {
  id: string;
  step: string | null;
  name: string;
  verdict: string;
  detail: string;
  basis: string;
  restsOn: string;
  notAssessed: boolean;
  quotes: { text: string; startSec: number | null }[];
};

function Finding({ f }: { f: FindingShape }) {
  // Verdict lives on the left edge, so the card keeps the app's own surface
  // and the text stays the most legible thing in it.
  const tone = f.notAssessed
    ? VERDICT_TONE.notAssessed
    : (VERDICT_TONE[f.verdict] ?? VERDICT_TONE.review);

  return (
    <Card className={cn('border-l-4 p-4', tone.edge)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">
          {f.step ? (
            <span className="mr-2 text-muted-foreground">{f.step}</span>
          ) : null}
          {f.name}
        </p>
        <Pill className={tone.pill}>{tone.label}</Pill>
      </div>

      <p className="mt-2 text-sm">{f.detail}</p>

      {f.quotes.length > 0 ? (
        <div className="mt-3 space-y-2">
          {f.quotes.map((q, i) => {
            const clock = formatClock(q.startSec);
            return (
              <blockquote
                key={i}
                className="rounded-sm border-l-2 border-border bg-muted/40 py-2 pr-3 pl-3 text-sm"
              >
                {clock ? (
                  <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">
                    {clock}
                  </span>
                ) : null}
                {/* Full turn, never truncated: the quote is read from the
                    transcript at render time, not copied into the audit. */}
                <span>{q.text}</span>
              </blockquote>
            );
          })}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">
        {BASIS_LABEL[f.basis] ?? f.basis} — {f.restsOn}
      </p>
    </Card>
  );
}
