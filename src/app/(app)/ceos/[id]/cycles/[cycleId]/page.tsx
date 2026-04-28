import { SingleCyclePage } from '@/components/dashboard/single-cycle-page';

export const dynamic = 'force-dynamic';

export default async function CyclePage({
  params,
}: {
  params: Promise<{ id: string; cycleId: string }>;
}) {
  const { id: ceoId, cycleId } = await params;
  return <SingleCyclePage ceoId={ceoId} cycleId={cycleId} />;
}
