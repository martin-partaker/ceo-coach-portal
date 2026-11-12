import { redirect, notFound } from 'next/navigation';
import { createServerCaller } from '@/lib/trpc/server';
import { AuditTranscriptClient } from '@/components/admin/audit-transcript-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** The transcript of one audited session. A quote's minute on the audit page
 *  opens this at the passage (`#L12-15`). */
export default async function AuditTranscriptPage({ params }: PageProps) {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  return <AuditTranscriptClient auditId={id} />;
}
