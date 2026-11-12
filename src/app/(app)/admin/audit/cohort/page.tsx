import { redirect } from 'next/navigation';
import { Users } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';
import { AuditCohortClient } from '@/components/admin/audit-cohort-client';

export const dynamic = 'force-dynamic';

export default async function AuditCohortPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Across the cohort</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The same findings as the session reviews, counted across every audited
          Session 1. What shows up on most sessions is about the programme or the
          training, not about one coach.
        </p>
      </div>

      <AuditCohortClient />
    </div>
  );
}
