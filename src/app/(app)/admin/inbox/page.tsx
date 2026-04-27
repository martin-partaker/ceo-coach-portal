import { redirect } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';
import { InboxTabs } from '@/components/admin/inbox-tabs';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Review unmatched submissions and register new Tally forms.
        </p>
      </div>

      <InboxTabs />
    </div>
  );
}
