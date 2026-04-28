import { redirect } from 'next/navigation';
import { createServerCaller } from '@/lib/trpc/server';
import { RosterV2Page } from '@/components/admin/roster-v2-page';

export const dynamic = 'force-dynamic';

export default async function AdminRosterPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return <RosterV2Page currentCoachId={me.id} />;
}
