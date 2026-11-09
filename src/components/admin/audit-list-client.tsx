'use client';

import Link from 'next/link';
import { Loader2, Clock, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { Card } from '@/components/ui/card';
import { ConfidenceBadge } from './audit-confidence';

export function AuditListClient() {
  const { data, isLoading, error } = trpc.audit.list.useQuery();

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

  const audited = data.filter((r) => r.familiesExamined.length > 0);
  const notAudited = data.filter((r) => r.familiesExamined.length === 0);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Audited — {audited.length}
        </h2>
        <div className="space-y-2">
          {audited.map((r) => (
            <Link key={r.auditId} href={`/admin/audit/${r.auditId}`}>
              <Card className="p-4 transition-colors hover:bg-accent/40">
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
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ConfidenceBadge value={r.confidence} />
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

                <div className="mt-3 flex flex-wrap gap-4 text-xs">
                  <span className={r.concernCount > 0 ? 'font-medium' : ''}>
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
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {notAudited.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Not audited — {notAudited.length}
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">
            These recordings could not be placed in the programme, so there is
            no outline to judge them against. They are listed rather than
            dropped: a missing row looks like nothing to review, and that is a
            different statement from &ldquo;we do not know what this is&rdquo;.
          </p>
          <div className="space-y-2">
            {notAudited.map((r) => (
              <Card key={r.auditId} className="p-4">
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
                    </p>
                  </div>
                  <ConfidenceBadge value={r.confidence} />
                </div>
                <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{r.confidenceReason}</span>
                </p>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
