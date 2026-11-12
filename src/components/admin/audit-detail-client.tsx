'use client';

import Link from 'next/link';
import { ArrowLeft, Loader2, AlertTriangle, Info, Check, Minus } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  ConfidenceBadge,
  Pill,
  VERDICT_TONE,
  formatClock,
} from './audit-confidence';

/**
 * One audited session.
 *
 * The spine is the OUTLINE, step by step, in the outline's own numbering and
 * order. That is how the Director of Coaching reads a review: she keeps it
 * open, scans it, and jumps to the part of the call that needs listening to,
 * so it has to map one-to-one onto the script the coaches were given. Every
 * finding that concerns a step sits under that step, whatever family of
 * criteria it came from.
 *
 * The criteria document groups the same findings by family instead (process,
 * substance, craft, preparation). Both orderings are views of one list — each
 * finding carries a `family` and a `step` — so nothing about the data chooses
 * between them. What has no step is about the session as a whole and is read
 * once, after the steps: preparation, the Coaching Standards, conduct.
 */

const WHOLE_SESSION: { family: string; title: string; blurb: string }[] = [
  {
    family: 'D',
    title: 'Preparation — did the coach use what the CEO sent?',
    blurb:
      'Against the Intake Survey and the 10x Goal Worksheet, filed before the session.',
  },
  {
    family: 'C',
    title: 'Coaching Standards',
    blurb:
      'Only the standards a transcript can show. The rest are named as not ' +
      'assessed rather than passed over.',
  },
];

const BASIS_LABEL: Record<string, string> = {
  source: 'from a ScaleOS document',
  documented: 'named by Lauren and/or Megan',
  proposed: 'our proposal',
};

type FindingShape = {
  id: string;
  step: string | null;
  name: string;
  family: string;
  verdict: string;
  detail: string;
  basis: string;
  restsOn: string;
  notAssessed: boolean;
  quotes: { text: string; startSec: number | null }[];
};

const toneKey = (f: FindingShape) =>
  f.notAssessed ? 'notAssessed' : f.verdict in VERDICT_TONE ? f.verdict : 'review';

const toneOf = (f: FindingShape) => VERDICT_TONE[toneKey(f)];

/** Worst first. "Not assessed" outranks "clear": a hole is not good news. */
const SEVERITY = ['concern', 'review', 'notAssessed', 'ok'];

const worstTone = (fs: FindingShape[]) => {
  const keys = fs.map(toneKey);
  return VERDICT_TONE[SEVERITY.find((k) => keys.includes(k)) ?? 'ok'];
};

const anchorOf = (step: string | null) => `step-${(step ?? '').replace(/[^a-z0-9]+/gi, '-')}`;

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
        <Notice>{data.reason}</Notice>
      </div>
    );
  }

  const { audit, transcript } = data;
  const findings = audit.findings as FindingShape[];
  const examined = new Set<string>(audit.familiesExamined);

  const steps = findings.filter((f) => f.family === 'A');
  const stepIds = new Set(steps.map((s) => s.step));
  const others = findings.filter((f) => f.family !== 'A');
  // A finding belongs under a step only if that step exists in this outline.
  // Anything else — no step, or a block name like "Coach" from the timing
  // checks — is about the session as a whole.
  const under = (step: string | null) =>
    others.filter((f) => f.step !== null && f.step === step && f.family !== 'conduct');
  const loose = others.filter((f) => f.step === null || !stepIds.has(f.step));
  const conduct = others.filter((f) => f.family === 'conduct');

  const count = (test: (f: FindingShape) => boolean) => findings.filter(test).length;
  const toRaise = count((f) => f.verdict === 'concern' && !f.notAssessed);
  const toReview = count((f) => f.verdict === 'review' && !f.notAssessed);
  const notAssessed = count((f) => f.notAssessed);

  return (
    <div className="space-y-8">
      <BackLink />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {transcript.title ?? 'Untitled recording'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ConfidenceBadge value={audit.confidence} />
          {audit.coachLabel ? (
            <span className="text-sm text-muted-foreground">{audit.coachLabel}</span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            criteria {audit.criteriaVersion}
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          {audit.confidenceReason}
        </p>
        {audit.coachNote ? (
          <p className="mt-2 flex max-w-3xl gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{audit.coachNote}</span>
          </p>
        ) : null}
        {examined.size > 0 && !transcript.hasCueTimes ? (
          <p className="mt-2 flex max-w-3xl gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              No cue times were captured for this recording, so quotes below show
              the words but cannot point at a moment in the call.
            </span>
          </p>
        ) : null}
      </div>

      {/* A recording we could not place is not judged against any outline.
          It must not render as an empty — and therefore clean — review. */}
      {examined.size === 0 ? (
        <Notice>
          <strong>Not audited.</strong> We could not establish which session this
          recording is, so there is no outline to judge it against. Nothing below
          means nothing was looked at — not that nothing was wrong.
        </Notice>
      ) : (
        <>
          <div className="space-y-3">
            <p className="text-sm">
              <span className={toRaise ? 'font-medium text-rose-700 dark:text-rose-300' : ''}>
                {toRaise} to raise
              </span>
              <span className="text-muted-foreground">
                {' · '}
                {toReview} to review{' · '}
                {notAssessed} not assessed
              </span>
            </p>
            {/* The outline at a glance: scan, then jump. */}
            <nav className="flex flex-wrap gap-1.5" aria-label="Outline steps">
              {steps.map((s) => {
                const worst = worstTone([s, ...under(s.step)]);
                return (
                  <a key={s.id} href={`#${anchorOf(s.step)}`}>
                    <Pill className={cn(worst.pill, 'hover:opacity-80')}>
                      {s.step} {s.name}
                    </Pill>
                  </a>
                );
              })}
            </nav>
          </div>

          <section className="space-y-3">
            <SectionHead
              title="The session, step by step"
              blurb={
                'The outline in its own numbering and order, so it lines up with the ' +
                'script the coaches work from. A step that is missing or out of order ' +
                'is an observation, never a finding on its own.'
              }
            />
            {steps.map((s) => (
              <StepBlock key={s.id} step={s} findings={under(s.step)} />
            ))}
          </section>

          {loose.some((f) => f.family === 'B') ? (
            <section className="space-y-3">
              <SectionHead
                title="Across the session"
                blurb="Findings about the session as a whole rather than one step — how the time was spent."
              />
              <div className="space-y-2">
                {loose
                  .filter((f) => f.family === 'B')
                  .map((f) => (
                    <Finding key={`${f.id}-${f.step ?? ''}`} f={f} />
                  ))}
              </div>
            </section>
          ) : null}

          {WHOLE_SESSION.map(({ family, title, blurb }) => {
            const items = loose.filter((f) => f.family === family);
            return (
              <section key={family} className="space-y-3">
                <SectionHead title={title} blurb={blurb} />
                {!examined.has(family) ? (
                  <NotExamined />
                ) : items.length === 0 ? (
                  <Card className="gap-0 p-4">
                    <p className="text-sm text-muted-foreground">Examined, nothing raised.</p>
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

          <section className="space-y-3">
            <SectionHead
              title="Conduct"
              blurb={
                'A checklist against Coach Policies. A tick means nothing in the ' +
                'transcript indicates it — a transcript cannot show what was said ' +
                'outside the recording. Anything found is shown with the coach’s exact ' +
                'words, to be read rather than taken on trust.'
              }
            />
            {!examined.has('conduct') ? <NotExamined /> : <ConductChecklist items={conduct} />}
          </section>
        </>
      )}
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

function SectionHead({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{blurb}</p>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Card className="gap-0 border-l-4 border-l-amber-500 bg-amber-500/[0.08] p-4 dark:bg-amber-500/[0.06]">
      <p className="flex gap-2 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>{children}</span>
      </p>
    </Card>
  );
}

/** The distinction these screens exist to protect: an empty list is only good
 *  news if the thing was looked at. */
function NotExamined() {
  return (
    <Notice>
      <strong>Not examined.</strong> This was not run for this session, so an empty
      list here means nothing was looked at — not that nothing was wrong.
    </Notice>
  );
}

function Quotes({ quotes }: { quotes: FindingShape['quotes'] }) {
  if (quotes.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {quotes.map((q, i) => {
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
            {/* The whole passage, never truncated: it is read from the
                transcript when the page renders, not copied into the audit. */}
            <span>{q.text}</span>
          </blockquote>
        );
      })}
    </div>
  );
}

function Provenance({ f }: { f: FindingShape }) {
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      {BASIS_LABEL[f.basis] ?? f.basis} — {f.restsOn}
    </p>
  );
}

/** One outline step: whether it happened, then everything found about it. */
function StepBlock({ step, findings }: { step: FindingShape; findings: FindingShape[] }) {
  const tone = toneOf(step);
  return (
    <Card id={anchorOf(step.step)} className={cn('scroll-mt-6 gap-0 border-l-4 p-4', tone.edge)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base font-semibold">
          <span className="mr-2 text-muted-foreground">{step.step}</span>
          {step.name}
        </h3>
        <Pill className={tone.pill}>{tone.label}</Pill>
      </div>
      <p className="mt-2 text-sm">{step.detail}</p>
      <Quotes quotes={step.quotes} />
      <Provenance f={step} />

      {findings.length > 0 ? (
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            On this step
          </p>
          {findings.map((f) => (
            // Opaque backing, so the finding's tint sits on the page colour
            // and not on the step's own tint: a red inside a green step
            // otherwise mixes to grey and stops reading as red.
            <div key={`${f.id}-${f.step ?? ''}`} className="rounded-xl bg-background">
              <Finding f={f} nested />
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function Finding({ f, nested = false }: { f: FindingShape; nested?: boolean }) {
  // Verdict lives on the left edge and a light tint, so the text stays the
  // most legible thing on the card.
  const tone = toneOf(f);
  return (
    <Card className={cn('gap-0 border-l-4 p-4', tone.edge, nested && 'shadow-none')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">
          {!nested && f.step ? (
            <span className="mr-2 text-muted-foreground">{f.step}</span>
          ) : null}
          {f.name}
        </p>
        <Pill className={tone.pill}>{tone.label}</Pill>
      </div>
      <p className="mt-2 text-sm">{f.detail}</p>
      <Quotes quotes={f.quotes} />
      <Provenance f={f} />
    </Card>
  );
}

/**
 * Conduct as a checklist, the format the Director of Coaching asked for: one
 * line per item, a tick or a flag, and where something was found the moment
 * and the exact words so she can verify it herself.
 */
function ConductChecklist({ items }: { items: FindingShape[] }) {
  if (items.length === 0) {
    return (
      <Card className="gap-0 p-4">
        <p className="text-sm text-muted-foreground">No checklist items were produced.</p>
      </Card>
    );
  }
  return (
    <Card className="gap-0 divide-y divide-border p-0">
      {items.map((f) => {
        const tone = toneOf(f);
        const Icon = f.notAssessed ? Minus : f.verdict === 'ok' ? Check : AlertTriangle;
        const iconColor = f.notAssessed
          ? 'text-zinc-500'
          : f.verdict === 'ok'
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400';
        return (
          <div key={f.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="flex items-start gap-2 font-medium">
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconColor)} />
                {f.name}
              </p>
              <Pill className={tone.pill}>
                {f.notAssessed ? 'not assessed' : f.verdict === 'ok' ? 'nothing found' : 'to verify'}
              </Pill>
            </div>
            <p className="mt-2 pl-6 text-sm">{f.detail}</p>
            <div className="pl-6">
              <Quotes quotes={f.quotes} />
              <Provenance f={f} />
            </div>
          </div>
        );
      })}
    </Card>
  );
}
