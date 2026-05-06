import { redirect } from 'next/navigation';
import { Database } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';
import { DataPageClient } from '@/components/admin/data-page-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function DataPage({ searchParams }: PageProps) {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  const params = await searchParams;
  // Default tab logic: send the operator straight into Triage when there's
  // pending work, otherwise show the All-data browser. Either tab can be
  // forced via ?view= so the choice survives reloads after a deep-link.
  const initialView: 'triage' | 'all' =
    params.view === 'triage' || params.view === 'all'
      ? params.view
      : 'triage';

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Data</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Triage incoming submissions one-by-one, or browse and edit every
          row in the ingestion layer.
        </p>
      </div>

      <DataPageClient initialView={initialView} />
    </div>
  );
}
