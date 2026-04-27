import { redirect } from 'next/navigation';
import { ListChecks } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';
import { TriageWalkthrough } from '@/components/admin/triage-walkthrough';

export const dynamic = 'force-dynamic';

export default async function TriagePage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Triage</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          One-by-one verification. AI proposes, you confirm.
        </p>
      </div>

      <TriageWalkthrough />
    </div>
  );
}
