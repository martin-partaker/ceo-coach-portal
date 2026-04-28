import { redirect } from 'next/navigation';
import { createServerCaller } from '@/lib/trpc/server';
import { RosterPage } from '@/components/admin/roster-page';

export const dynamic = 'force-dynamic';

export default async function AdminRosterPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return <RosterPage currentCoachId={me.id} />;
}
