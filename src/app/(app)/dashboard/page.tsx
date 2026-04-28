import { createServerCaller } from '@/lib/trpc/server';
import { CoachDashboardWrapper } from '@/components/dashboard/coach-dashboard-wrapper';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  return <CoachDashboardWrapper currentCoachId={me.id} />;
}
