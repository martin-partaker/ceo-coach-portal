import { redirect } from 'next/navigation';
import { Plug2 } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';
import { InboxDiscoveredForms } from '@/components/admin/inbox-discovered-forms';
import { TallySyncButton } from '@/components/admin/tally-sync-button';
import { ZoomSyncButton } from '@/components/admin/zoom-sync-button';

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Plug2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure how external data flows in. Submissions land in Triage to
          be assigned to CEOs.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Tally forms</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tally submissions sync automatically every few minutes. Use{' '}
              <span className="font-medium">Sync now</span> if you just added a
              form or are missing recent submissions.
            </p>
          </div>
          <TallySyncButton />
        </div>
        <InboxDiscoveredForms />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Zoom recordings</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Zoom transcripts sync automatically every few hours via cron.
              Use <span className="font-medium">Sync now</span> to backfill the
              last 12 months across every coach with a Zoom email — useful if
              meetings were missed or transcripts uploaded late. Duplicates are
              skipped, so it&apos;s safe to run repeatedly.
            </p>
          </div>
          <ZoomSyncButton />
        </div>
      </section>
    </div>
  );
}
