import { redirect, notFound } from 'next/navigation';
import { createServerCaller } from '@/lib/trpc/server';
import { AuditDetailClient } from '@/components/admin/audit-detail-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AuditDetailPage({ params }: PageProps) {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  return <AuditDetailClient auditId={id} />;
}
