'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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
import { CycleWorkspace } from '@/components/admin/roster-v2-workspace';

/**
 * Deep-link page that mounts the same CycleWorkspace shown inline in the
 * dashboard, pre-loaded with a specific cycle. Uses `roster.cycleSummary`
 * (coach-scoped per Phase 1) so a coach can only land on their own
 * CEOs' cycles; an unscoped admin sees any cycle.
 *
 * The active cycle is locally controllable so the workspace's tab strip
 * lets you flip between cycles without leaving the page.
 */
export function SingleCyclePage({
  ceoId,
  cycleId,
}: {
  ceoId: string;
  cycleId: string;
}) {
  // Deep-link page: ask for 'all' so an admin can land on any CEO's
  // cycle. Non-admins fall through to coach scope server-side, so a
  // regular coach still only sees their own CEOs here.
  const summaryQuery = trpc.roster.cycleSummary.useQuery({ scope: 'all' });
  const summary = useMemo(() => {
    if (!summaryQuery.data) return null;
    return (
      summaryQuery.data.find(
        (s) => s.ceo.id === ceoId && s.cycles.some((c) => c.id === cycleId),
      ) ?? null
    );
  }, [summaryQuery.data, ceoId, cycleId]);

  const [activeCycleId, setActiveCycleId] = useState<string>(cycleId);
  // If the URL changes (or summary loads after mount and the cycle moves),
  // re-anchor on the requested cycle id.
  useEffect(() => {
    setActiveCycleId(cycleId);
  }, [cycleId]);

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
        Cycle not found, or you don&apos;t have access to it.
      </div>
    );
  }

  const activeCycle =
    summary.cycles.find((c) => c.id === activeCycleId) ?? summary.cycles[summary.cycles.length - 1];

  return (
    <div className="space-y-5">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href={`/ceos/${ceoId}`}>{summary.ceo.name}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{activeCycle?.label ?? 'Cycle'}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {activeCycle && (
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <CycleWorkspace
            summary={summary}
            cycles={summary.cycles}
            activeCycleId={activeCycle.id}
            onActiveCycleIdChange={setActiveCycleId}
          />
        </div>
      )}
    </div>
  );
}
