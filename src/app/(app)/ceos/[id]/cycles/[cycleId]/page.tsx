import { createServerCaller } from '@/lib/trpc/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
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
      <div>
        <Link
          href={`/ceos/${ceoId}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to {ceo.name}
        </Link>
      </div>

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
