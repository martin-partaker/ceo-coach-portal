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

  const { cycle, ceo, journals, transcripts: cycleTranscripts } = data;
  if (ceo.id !== ceoId) notFound();

  const coach = await api.coaches.getMe();

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
