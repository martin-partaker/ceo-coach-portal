'use client';

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import type { RosterCeoSummary, RosterCycle } from '@/server/api/routers/roster';
import { RosterV2Row } from '@/components/admin/roster-v2-row';
import { CycleWorkspace } from '@/components/admin/roster-v2-workspace';

/**
 * Deep-link page for a single CEO. Renders the same RosterV2Row +
 * CycleWorkspace experience the dashboard expands inline, but pinned
 * to one CEO and pre-expanded so the user can immediately see the
 * latest cycle. Backed by `roster.cycleSummary` (coach-scoped per
 * Phase 1) so coaches can only land on their own CEOs and admins can
 * land on anyone's.
 */
export function SingleCeoPage({ ceoId }: { ceoId: string }) {
  // Deep-link page: ask for 'all' so an admin can land on any CEO. A
  // regular coach falls through to coach scope server-side, so this
  // still filters to their own CEOs.
  const summaryQuery = trpc.roster.cycleSummary.useQuery({ scope: 'all' });
  const summary = useMemo(() => {
    if (!summaryQuery.data) return null;
    return summaryQuery.data.find((s) => s.ceo.id === ceoId) ?? null;
  }, [summaryQuery.data, ceoId]);

  // /ceos/[id] always renders with surface='coach' — even an admin
  // landing here gets the focused per-CEO view; cross-coach actions
  // like "Reassign coach" stay on /admin/ceos. So we never need coach
  // options on this page.

  if (summaryQuery.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
        CEO not found, or you don&apos;t have access to them.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{summary.ceo.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <RosterV2Row
          summary={summary}
          coaches={[]}
          expanded={true}
          onToggle={() => {}}
          surface="coach"
          renderExpanded={(active: RosterCycle, all: RosterCycle[], setActive, intent) => (
            <ExpandedCycleWorkspace
              summary={summary}
              cycleId={active.id}
              cycles={all}
              onChange={setActive}
              reviewKey={intent.reviewKey}
            />
          )}
        />
      </div>
    </div>
  );
}

function ExpandedCycleWorkspace({
  summary,
  cycleId,
  cycles,
  onChange,
  reviewKey,
}: {
  summary: RosterCeoSummary;
  cycleId: string;
  cycles: RosterCycle[];
  onChange: (id: string) => void;
  reviewKey: number;
}) {
  return (
    <CycleWorkspace
      summary={summary}
      cycles={cycles}
      activeCycleId={cycleId}
      onActiveCycleIdChange={onChange}
      reviewKey={reviewKey}
    />
  );
}
