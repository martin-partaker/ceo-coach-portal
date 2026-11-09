import { redirect } from 'next/navigation';
import { ClipboardCheck } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';
import { AuditListClient } from '@/components/admin/audit-list-client';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">
            Session review
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Session 1 quality audits. Each row says how sure we are which session
          it is — sessions we cannot place are listed with the reason rather
          than hidden.
        </p>
      </div>

      <AuditListClient />
    </div>
  );
}
