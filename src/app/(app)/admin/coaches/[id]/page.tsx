import { createServerCaller } from '@/lib/trpc/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Users, CheckCircle2 } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { AdminToggleButton } from '@/components/admin/admin-toggle-button';
import { ImpersonateButton } from '@/components/admin/impersonate-button';

export const dynamic = 'force-dynamic';

export default async function AdminCoachDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  let data;
  try {
    data = await api.admin.getCoachDetail({ coachId: id });
  } catch {
    notFound();
  }

  const { coach, ceos } = data;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/admin">Admin</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{coach.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-end justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{coach.name}</h1>
              {coach.isSuperAdmin && (
                <Badge className="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 text-xs">
                  Admin
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground font-mono">{coach.email}</p>
          </div>
          <div className="flex gap-2">
            <AdminToggleButton coachId={coach.id} isAdmin={coach.isSuperAdmin} isSelf={coach.id === me.id} />
            <ImpersonateButton coachId={coach.id} hasAuthAccount={!!coach.neonAuthUserId} />
          </div>
        </div>
      </div>

      {/* Coach info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Coach Details</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span>{!coach.neonAuthUserId ? 'Pending signup' : 'Active'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Zoom email</span>
              <span className="font-mono text-xs">{coach.zoomUserEmail ?? 'Not set'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Joined</span>
              <span className="font-mono text-xs">{new Date(coach.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">CEOs</span>
              <span>{ceos.length}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* CEO list */}
      <div>
        <h2 className="mb-4 text-lg font-medium">CEOs ({ceos.length})</h2>
        {ceos.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="h-8 w-8 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">No CEOs assigned yet.</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <div className="divide-y divide-border">
              {ceos.map(({ ceo, latestCycle, hasReport }) => (
                <div
                  key={ceo.id}
                  className="flex items-center justify-between px-6 py-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                      {ceo.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{ceo.name}</p>
                      {ceo.email && (
                        <p className="text-xs text-muted-foreground">{ceo.email}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {latestCycle && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {latestCycle.label}
                      </span>
                    )}
                    {hasReport ? (
                      <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[11px]">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Report
                      </Badge>
                    ) : latestCycle ? (
                      <Badge variant="secondary" className="text-[11px]">In progress</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[11px]">No cycle</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
