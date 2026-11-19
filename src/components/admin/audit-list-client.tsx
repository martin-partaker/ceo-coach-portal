'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Clock, AlertTriangle, Users } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ConfidenceBadge, CONFIDENCE_TONE } from './audit-confidence';
import { sessionWords } from '@/lib/audit/session-override';
import { OUTLINE_GROUP_LABEL, outlineGroup } from '@/lib/audit/contract';

type Filter = 'start' | 'all' | 1 | 2 | 3 | 4;
type Period = 'all' | 'before' | 'since';

export function AuditListClient() {
  const { data, isLoading, error } = trpc.audit.list.useQuery();
  // Which sessions to show. Starts on the first batch: two hundred cards at
  // once is a wall, and a dozen recent sessions spread across the session
  // types and the coaches are enough to find where the criteria are wrong.
  const [chosen, setFilter] = useState<Filter>('start');
  // Recorded before or since the month the outline is dated. Most recordings
  // are older than the outline they are judged against, and a step missing
  // from those may not have been asked of the coach yet.
  const [period, setPeriod] = useState<Period>('all');

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading audits…
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No audits loaded yet.
      </p>
    );
  }

  // A reviewer has said these are another session than their audit was run
  // as. The audit on file is void until the next run, so they are neither
  // "audited" nor "not placed": they are waiting.
  const waiting = data.filter((r) => r.session.standing === 'superseded');
  const settled = data.filter((r) => r.session.standing !== 'superseded');
  const allAudited = settled.filter((r) => r.familiesExamined.length > 0);
  const batch = allAudited
    .filter((r) => r.firstBatchRank !== null)
    .sort((a, b) => (a.firstBatchRank ?? 0) - (b.firstBatchRank ?? 0));
  // No batch (nothing fully read yet): open on Session 1, as before.
  const filter: Filter = chosen === 'start' && batch.length === 0 ? 1 : chosen;
  const inFilter =
    filter === 'start'
      ? batch
      : filter === 'all'
        ? allAudited
        : allAudited.filter((r) => outlineGroup(r.sessionNo) === filter);
  // The batch is recent by construction, so the date choice is not offered on it.
  const before = filter === 'start' ? [] : inFilter.filter((r) => r.predatesOutline === true);
  const since = filter === 'start' ? [] : inFilter.filter((r) => r.predatesOutline === false);
  const audited =
    filter === 'start' ? batch : period === 'before' ? before : period === 'since' ? since : inFilter;
  const notAudited = settled.filter((r) => r.familiesExamined.length === 0);
  const perGroup = (g: 1 | 2 | 3 | 4) =>
    allAudited.filter((r) => outlineGroup(r.sessionNo) === g).length;
  const chip = (value: Filter, label: string, count: number) => (
    <button
      key={String(value)}
      type="button"
      onClick={() => setFilter(value)}
      aria-pressed={filter === value}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors',
        filter === value
          ? 'border-foreground/40 bg-foreground/10 font-medium'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
      <span className="tabular-nums text-xs text-muted-foreground">{count}</span>
    </button>
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-1.5">
        {batch.length > 0 ? chip('start', 'Start here', batch.length) : null}
        {([1, 2, 3, 4] as const).map((g) => chip(g, OUTLINE_GROUP_LABEL[g], perGroup(g)))}
        {chip('all', 'All', allAudited.length)}
      </div>
      {before.length + since.length > 0 ? (
        <div className="-mt-5 flex flex-wrap items-center gap-1.5">
          {(
            [
              ['all', 'Any date', inFilter.length],
              ['before', 'Recorded before the outline', before.length],
              ['since', 'Recorded since the outline', since.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              onClick={() => setPeriod(value)}
              aria-pressed={period === value}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                period === value
                  ? 'border-foreground/40 bg-foreground/10 font-medium'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {label}
              <span className="tabular-nums text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>
      ) : null}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {filter === 'start'
              ? `Start here — ${audited.length}`
              : `Audited${filter === 'all' ? '' : `, ${OUTLINE_GROUP_LABEL[filter]}`} — ${audited.length}`}
          </h2>
          {/* The same findings counted across all of these sessions. */}
          <Link
            href="/admin/audit/cohort"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <Users className="h-4 w-4" /> Across the cohort
          </Link>
        </div>
        {filter === 'start' ? (
          <p className="max-w-3xl text-xs text-muted-foreground">
            A first batch to review: the most recent sessions, spread across the session
            types and the coaches, with no CEO twice. Two each from Sessions 1, 2 and 3
            and up to six from Sessions 4–12. Your answers on these show where the
            criteria are wrong; everything else is under the other tabs.
          </p>
        ) : null}
        <div className="space-y-2">
          {audited.map((r) => (
            <Link key={r.auditId} href={`/admin/audit/${r.auditId}`}>
              <Card
                className={cn(
                  'border-l-4 p-4 transition-colors hover:bg-accent/40',
                  (CONFIDENCE_TONE[r.confidence] ?? CONFIDENCE_TONE.undetermined)
                    .edge,
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {r.ceoName ?? 'Unattributed CEO'}
                      {r.coachName ? (
                        <span className="text-muted-foreground">
                          {' '}
                          with {r.coachName}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {r.title ?? 'Untitled recording'}
                      {r.recordedAt
                        ? ` · ${new Date(r.recordedAt).toLocaleDateString()}`
                        : ''}
                      {r.predatesOutline === true ? ' · older than the outline' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ConfidenceBadge
                      value={r.confidence}
                      sessionNo={r.sessionNo}
                      setBy={r.session.override}
                    />
                    {!r.hasCueTimes ? (
                      <span
                        className="flex items-center gap-1 text-xs text-muted-foreground"
                        title="No cue times stored for this recording, so quotes cannot jump to a moment."
                      >
                        <Clock className="h-3 w-3" /> no timings
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
                  <span
                    className={cn(
                      r.concernCount > 0
                        ? 'font-medium text-rose-700 dark:text-rose-300'
                        : 'text-muted-foreground',
                    )}
                  >
                    {r.concernCount} to raise
                  </span>
                  <span className="text-muted-foreground">
                    {r.reviewCount} to review
                  </span>
                  {/* Never folded into a pass: an unassessed criterion is a
                      gap in what we could look at, not a clean result. */}
                  {r.notAssessedCount > 0 ? (
                    <span className="text-muted-foreground">
                      {r.notAssessedCount} not assessed
                    </span>
                  ) : null}
                  {/* The reviewer's own progress through this session. */}
                  {r.answeredCount + r.carriedCount > 0 ? (
                    <span className="ml-auto text-emerald-700 dark:text-emerald-300">
                      {r.answeredCount > 0 ? `${r.answeredCount} answered by you` : ''}
                      {r.answeredCount > 0 && r.carriedCount > 0 ? ' · ' : ''}
                      {/* Answers given on an earlier version of this audit:
                          inside, each either still stands or asks again. */}
                      {r.carriedCount > 0
                        ? `${r.carriedCount} from an earlier version`
                        : ''}
                    </span>
                  ) : null}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {waiting.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Session set by a reviewer, waiting for the next run — {waiting.length}
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">
            A reviewer has said these are another session than their audit was run
            as. That audit was judged against the wrong outline and is not shown; a
            new one replaces it the next time audits are generated.
          </p>
          <div className="space-y-2">
            {waiting.map((r) => (
              <Link key={r.auditId} href={`/admin/audit/${r.auditId}`}>
                <Card className="border-l-4 border-l-sky-500 p-4 transition-colors hover:bg-accent/40">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <Who r={r} />
                    <ConfidenceBadge
                      value={r.confidence}
                      sessionNo={r.sessionNo}
                      setBy={r.session.override}
                    />
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {r.familiesExamined.length > 0
                      ? `Audited as Session ${r.sessionNo}; now set to ${sessionWords(
                          r.session.override?.sessionNo ?? null,
                        )}.`
                      : `Was not placed; now set to ${sessionWords(
                          r.session.override?.sessionNo ?? null,
                        )}.`}
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Not on the first batch: placing thirteen recordings is another job
          than answering twelve audits, and it is one tab away. Sessions a
          reviewer has just corrected stay in view above, on every tab. */}
      {notAudited.length > 0 && filter !== 'start' ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Not audited — {notAudited.length}
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">
            These recordings could not be placed in the programme, or are a session
            there are no criteria for yet, so there is no outline to judge them
            against. They are listed rather than dropped: a missing row looks like
            nothing to review, and that is a different statement from &ldquo;we do
            not know what this is&rdquo;. Open one to say which session it is.
          </p>
          <div className="space-y-2">
            {notAudited.map((r) => (
              <Link key={r.auditId} href={`/admin/audit/${r.auditId}`}>
                <Card className="border-l-4 border-l-zinc-400 p-4 transition-colors hover:bg-accent/40 dark:border-l-zinc-500">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <Who r={r} />
                    <ConfidenceBadge
                      value={r.confidence}
                      sessionNo={r.sessionNo}
                      setBy={r.session.override}
                    />
                  </div>
                  <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>{r.confidenceReason}</span>
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Who the session is with, and which recording it is. */
function Who({
  r,
}: {
  r: { ceoName: string | null; coachName: string | null; title: string | null; recordedAt: Date | null };
}) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium">
        {r.ceoName ?? 'Unattributed CEO'}
        {r.coachName ? <span className="text-muted-foreground"> with {r.coachName}</span> : null}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {r.title ?? 'Untitled recording'}
        {r.recordedAt ? ` · ${new Date(r.recordedAt).toLocaleDateString()}` : ''}
      </p>
    </div>
  );
}
