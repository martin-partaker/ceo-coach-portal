import { createServerCaller } from '@/lib/trpc/server';
import { notFound } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { CycleInputForm } from '@/components/cycles/cycle-input-form';
import { ReportView } from '@/components/cycles/report-view';

export const dynamic = 'force-dynamic';

export default async function CyclePage({
  params,
}: {
  params: Promise<{ id: string; cycleId: string }>;
}) {
  const { id: ceoId, cycleId } = await params;
  const api = await createServerCaller();

  let data;
  try {
    data = await api.cycles.get({ id: cycleId });
  } catch {
    notFound();
  }

  const { cycle, ceo, journals: existingJournals, transcripts: cycleTranscripts } = data;
  if (ceo.id !== ceoId) notFound();

  const coach = await api.coaches.getMe();

  // Auto-seed journal entries based on session dates if none exist
  let journals = existingJournals;
  if (journals.length === 0 && cycle.periodStart && cycle.periodEnd) {
    const start = new Date(cycle.periodStart);
    const end = new Date(cycle.periodEnd);
    const weeks = Math.min(Math.ceil((end.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)), 8);
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    for (let i = 0; i < weeks; i++) {
      const weekStart = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
      const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
      await api.cycles.addJournal({
        cycleId,
        weekNumber: i + 1,
        title: `Week ${i + 1} — ${fmt(weekStart)} to ${fmt(weekEnd)}`,
      });
    }

    // Re-fetch after seeding
    const refreshed = await api.cycles.get({ id: cycleId });
    journals = refreshed.journals;
  }

  return (
    <div className="space-y-8">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href={`/ceos/${ceoId}`}>{ceo.name}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{cycle.label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <CycleInputForm
        cycle={cycle}
        ceoId={ceoId}
        ceoName={ceo.name}
        cycleLabel={cycle.label}
        hasZoomEmail={!!coach.zoomUserEmail}
        hasTenXGoal={!!ceo.tenXGoal?.trim()}
        initialJournals={journals}
        initialTranscripts={cycleTranscripts}
      />

      <ReportView cycleId={cycleId} />
    </div>
  );
}
