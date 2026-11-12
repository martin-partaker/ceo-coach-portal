'use client';

import Link from 'next/link';
import { ArrowLeft, Info, Loader2 } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Pill, VERDICT_TONE } from './audit-confidence';

/**
 * The cohort view.
 *
 * Deliberately a table of counts and nothing more. With two to nine sessions
 * per coach, a percentage or a bar would dress a handful of sessions up as a
 * rate; "2 of 3" says exactly as much as is known.
 *
 * Every number opens onto the sessions behind it, because a count nobody can
 * check is the thing this whole tool was rebuilt to avoid.
 */

type Tone = 'ok' | 'review' | 'concern' | 'notAssessed';
type Counts = Record<Tone, number>;
type Row = {
  key: string;
  id: string;
  step: string | null;
  family: string;
  readBy: string | null;
  label: string;
  counts: Counts;
  notRaised: number;
  byCoach: { coach: string; counts: Counts; sessions: number }[];
  sessions: { auditId: string; who: string; coach: string; tone: Tone }[];
};

const TONES: Tone[] = ['ok', 'review', 'concern', 'notAssessed'];
const anchorOf = (step: string | null) => `step-${(step ?? '').replace(/[^a-z0-9]+/gi, '-')}`;

function Count({ n, tone }: { n: number; tone: Tone }) {
  if (n === 0) return <span className="text-muted-foreground/50">–</span>;
  return <Pill className={VERDICT_TONE[tone].pill}>{n}</Pill>;
}

export function AuditCohortClient() {
  const { data, isLoading, error } = trpc.audit.cohort.useQuery();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Counting…
      </div>
    );
  }
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!data || data.sessionCount === 0) {
    return <p className="text-sm text-muted-foreground">No audited sessions yet.</p>;
  }

  const n = data.sessionCount;

  return (
    <div className="space-y-8">
      <Link
        href="/admin/audit"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All sessions
      </Link>

      <Card className="gap-0 p-4">
        <p className="text-sm">
          <span className="font-medium">{n} audited sessions</span>
          <span className="text-muted-foreground">
            {' · '}criteria {data.versions.join(', ')}
          </span>
        </p>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {data.coaches.map((c) => (
            <span key={c.name}>
              {c.name} <span className="tabular-nums text-foreground">{c.sessions}</span>
            </span>
          ))}
        </p>
        {/* Never folded into the counts below: these were not looked at. */}
        {data.notPlaced > 0 ? (
          <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {data.notPlaced} more recordings could not be placed as a Session 1 and
              were not audited. They are not in any number on this page.
            </span>
          </p>
        ) : null}
        {data.versions.length > 1 ? (
          <p className="mt-2 flex gap-2 text-xs text-amber-700 dark:text-amber-300">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              These sessions were audited under different criteria versions, so the
              counts mix two sets of rules.
            </span>
          </p>
        ) : null}
        <p className="mt-2 flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Counts, not rates: with a few sessions per coach, “2 of 3” is all that
            is known. Open a row to see the sessions behind each number.
          </span>
        </p>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Outline steps</h2>
          <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
            In how many sessions each step of the outline was found. “To review”
            means found weakly or not found — by a list of phrasings, so a step done
            in other words can be missed.
          </p>
        </div>
        <CohortTable rows={data.steps as Row[]} total={n} showNotRaised={false} />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Findings</h2>
          <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
            Most common first. “Not raised” counts the sessions where a finding that
            only appears when something is found did not appear.
          </p>
        </div>
        <CohortTable rows={data.findings as Row[]} total={n} showNotRaised />
      </section>
    </div>
  );
}

function CohortTable({
  rows,
  total,
  showNotRaised,
}: {
  rows: Row[];
  total: number;
  showNotRaised: boolean;
}) {
  return (
    <Card className="gap-0 overflow-x-auto p-0">
      <div className="min-w-[640px]">
        <div className="grid grid-cols-[minmax(0,1fr)_repeat(4,4.5rem)_5rem] items-center gap-2 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>of {total} sessions</span>
          {TONES.map((t) => (
            <span key={t} className="text-center">
              {VERDICT_TONE[t].label}
            </span>
          ))}
          <span className="text-center">{showNotRaised ? 'not raised' : ''}</span>
        </div>
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <details key={r.key} className="group">
              <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_repeat(4,4.5rem)_5rem] items-center gap-2 px-4 py-2.5 text-sm hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {r.step ? (
                    <span className="shrink-0 text-muted-foreground">{r.step}</span>
                  ) : null}
                  <span className="font-medium">{r.label}</span>
                  {r.readBy === 'model' ? (
                    <Pill className="bg-violet-500/15 text-violet-800 ring-1 ring-violet-500/40 ring-inset dark:text-violet-200">
                      AI reading
                    </Pill>
                  ) : null}
                </span>
                {TONES.map((t) => (
                  <span key={t} className="text-center tabular-nums">
                    <Count n={r.counts[t]} tone={t} />
                  </span>
                ))}
                <span className="text-center text-xs tabular-nums text-muted-foreground">
                  {showNotRaised && r.notRaised > 0 ? r.notRaised : ''}
                </span>
              </summary>

              <div className="space-y-3 bg-muted/30 px-4 py-3">
                <div className="space-y-1">
                  {r.byCoach.map((c) => (
                    <p key={c.coach} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-40 shrink-0 truncate">{c.coach}</span>
                      {TONES.filter((t) => c.counts[t] > 0).map((t) => (
                        <Pill key={t} className={VERDICT_TONE[t].pill}>
                          {c.counts[t]} {VERDICT_TONE[t].label}
                        </Pill>
                      ))}
                      <span className="text-xs text-muted-foreground">
                        of {c.sessions} session{c.sessions === 1 ? '' : 's'}
                      </span>
                    </p>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.sessions.map((s) => (
                    <Link
                      key={s.auditId}
                      href={`/admin/audit/${s.auditId}${r.step ? `#${anchorOf(r.step)}` : ''}`}
                      title={`${s.who} with ${s.coach}`}
                    >
                      <Pill className={cn(VERDICT_TONE[s.tone].pill, 'hover:opacity-80')}>
                        {s.who}
                      </Pill>
                    </Link>
                  ))}
                </div>
              </div>
            </details>
          ))}
        </div>
      </div>
    </Card>
  );
}
