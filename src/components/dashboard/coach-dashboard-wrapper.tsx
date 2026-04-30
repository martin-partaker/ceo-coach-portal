'use client';

import { useMemo } from 'react';
import { trpc } from '@/lib/trpc/client';
import type { RosterCycle } from '@/server/api/routers/roster';
import { RosterV2Page } from '@/components/admin/roster-v2-page';
import { CycleWorkspace } from '@/components/admin/roster-v2-workspace';

/**
 * Coach-side mount of the Dashboard page. The same `roster.cycleSummary`
 * query (now coach-scoped per Phase 1) backs both this and the admin
 * Dashboard at /admin/ceos — only `surface="coach"` flips the chrome:
 *   - no manager-mode toggle, no per-coach grouping
 *   - coach-scoped AddCeoDialog (`ceos.create`) instead of the
 *     admin RosterAddCeoDialog (`admin.createCeo`)
 *   - row dropdown hides admin-only Edit profile / Reassign / Delete
 *
 * The expanded inline workspace is identical to the admin one and is
 * wired through `renderExpanded` exactly the same way.
 *
 * (The internal component name "RosterV2Page" + the `roster.*` tRPC
 * router are kept as-is — only user-facing strings flipped to
 * "Dashboard". Renaming the internals would be a much bigger churn
 * for no behavioural payoff.)
 */
export function CoachDashboardWrapper({ currentCoachId }: { currentCoachId: string }) {
  return (
    <RosterV2Page
      currentCoachId={currentCoachId}
      surface="coach"
      renderExpanded={(active: RosterCycle, all: RosterCycle[], setActive, intent) => (
        <ExpandedFromCache
          cycleId={active.id}
          cycles={all}
          onChange={setActive}
          reviewKey={intent.reviewKey}
        />
      )}
    />
  );
}

function ExpandedFromCache({
  cycleId,
  cycles,
  onChange,
  reviewKey,
}: {
  cycleId: string;
  cycles: RosterCycle[];
  onChange: (id: string) => void;
  reviewKey: number;
}) {
  // Match the page-level scope ('coach') so this query reuses the same
  // cache entry rather than triggering a second request.
  const { data } = trpc.roster.cycleSummary.useQuery(
    { scope: 'coach' },
    { staleTime: 60_000 },
  );
  const summary = useMemo(() => {
    if (!data) return null;
    return data.find((s) => s.cycles.some((c) => c.id === cycleId)) ?? null;
  }, [data, cycleId]);

  if (!summary) return null;
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
