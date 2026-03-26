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
import { ActionItems } from '@/components/cycles/action-items';
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

  const { cycle, ceo } = data;
  if (ceo.id !== ceoId) notFound();

  const coach = await api.coaches.getMe();

  return (
    <div className="space-y-8">
      {/* Non-sticky back link */}
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

      {/* Sticky header with progress — rendered inside CycleInputForm as client component */}
      <CycleInputForm
        cycle={cycle}
        ceoId={ceoId}
        ceoName={ceo.name}
        cycleLabel={cycle.label}
        hasZoomEmail={!!coach.zoomUserEmail}
        hasTenXGoal={!!ceo.tenXGoal?.trim()}
        previousActionItemsReviewed={cycle.previousActionItemsReviewed}
      />

      {/* Action Items */}
      <ActionItems cycleId={cycleId} />

      {/* Report */}
      <ReportView cycleId={cycleId} />
    </div>
  );
}
