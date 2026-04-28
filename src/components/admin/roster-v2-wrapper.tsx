'use client';

import { useMemo } from 'react';
import { trpc } from '@/lib/trpc/client';
import type { RosterCeoSummary, RosterCycle } from '@/server/api/routers/roster';
import { RosterV2Page } from './roster-v2-page';
import { CycleWorkspace } from './roster-v2-workspace';
import { RosterV2Manager } from './roster-v2-manager';

/**
 * Wires Phase B (inline workspace) into the Roster v2 page via the
 * renderExpanded slot. Keeping the page component slot-based makes it
 * easy to plug in Phase C (manager mode) without rewriting state.
 */
export function RosterV2Wrapper({ currentCoachId }: { currentCoachId: string }) {
  return (
    <RosterV2Page
      currentCoachId={currentCoachId}
      renderExpanded={(current: RosterCycle, all: RosterCycle[]) => (
        <ExpandedFromCache cycleId={current.id} cycles={all} />
      )}
      renderManager={(summaries: RosterCeoSummary[]) => (
        <RosterV2Manager summaries={summaries} />
      )}
    />
  );
}

function ExpandedFromCache({
  cycleId,
  cycles,
}: {
  cycleId: string;
  cycles: RosterCycle[];
}) {
  const { data } = trpc.roster.cycleSummary.useQuery(undefined, { staleTime: 60_000 });
  const summary = useMemo(() => {
    if (!data) return null;
    return data.find((s) => s.cycles.some((c) => c.id === cycleId)) ?? null;
  }, [data, cycleId]);

  if (!summary) return null;
  return (
    <CycleWorkspace summary={summary} cycles={cycles} initialActiveCycleId={cycleId} />
  );
}
