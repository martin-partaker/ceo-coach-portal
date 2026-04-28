import { SingleCeoPage } from '@/components/dashboard/single-ceo-page';

export const dynamic = 'force-dynamic';

export default async function CeoProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SingleCeoPage ceoId={id} />;
}
