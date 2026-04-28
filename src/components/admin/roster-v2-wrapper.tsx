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
      renderExpanded={(active: RosterCycle, all: RosterCycle[], setActive, intent) => (
        <ExpandedFromCache
          cycleId={active.id}
          cycles={all}
          onChange={setActive}
          reviewKey={intent.reviewKey}
        />
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
  onChange,
  reviewKey,
}: {
  cycleId: string;
  cycles: RosterCycle[];
  onChange: (id: string) => void;
  reviewKey: number;
}) {
  // Match the page-level scope ('all') so this query reuses the same
  // cache entry rather than triggering a second request.
  const { data } = trpc.roster.cycleSummary.useQuery(
    { scope: 'all' },
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
