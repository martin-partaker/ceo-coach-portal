'use client';

import { useMemo } from 'react';
import { trpc } from '@/lib/trpc/client';
import type { RosterCycle } from '@/server/api/routers/roster';
import { RosterV2Page } from '@/components/admin/roster-v2-page';
import { CycleWorkspace } from '@/components/admin/roster-v2-workspace';

/**
 * Coach-side mount of the Roster v2 page. The same `roster.cycleSummary`
 * query (now coach-scoped per Phase 1) backs both this and the admin
 * Roster v2 — only `surface="coach"` flips the page chrome:
 *   - title "Dashboard" instead of "Roster"
 *   - no manager-mode toggle, no per-coach grouping
 *   - coach-scoped AddCeoDialog (`ceos.create`) instead of the
 *     admin RosterAddCeoDialog (`admin.createCeo`)
 *   - row dropdown hides admin-only Edit profile / Reassign / Delete
 *
 * The expanded inline workspace is identical to the admin one and is
 * wired through `renderExpanded` exactly the same way.
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
  const { data } = trpc.roster.cycleSummary.useQuery(undefined, { staleTime: 60_000 });
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
