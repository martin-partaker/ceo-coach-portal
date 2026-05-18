import { TeamsAdminPage } from '@/components/admin/teams-admin-page';

export const dynamic = 'force-dynamic';

/**
 * Admin Teams page — shows every coaching team, with management actions
 * (rename, transfer coach, resync, archive). Server component is a
 * thin shell so the team list can refetch via tRPC on the client.
 */
export default function AdminTeamsPage() {
  return <TeamsAdminPage />;
}
