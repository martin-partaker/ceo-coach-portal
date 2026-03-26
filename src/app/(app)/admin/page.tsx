import { createServerCaller } from '@/lib/trpc/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ShieldCheck, Users } from 'lucide-react';
import { CreateCoachDialog } from '@/components/admin/create-coach-dialog';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();

  if (!me.isSuperAdmin) redirect('/dashboard');

  const allCoaches = await api.admin.listCoaches();

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage coaches and view their dashboards.
          </p>
        </div>
        <CreateCoachDialog />
      </div>

      {/* Coach list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-medium">Coaches</CardTitle>
        </CardHeader>
        <Separator />
        <div className="divide-y divide-border">
          {allCoaches.map((coach) => (
            <Link
              key={coach.id}
              href={`/admin/coaches/${coach.id}`}
              className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                  {coach.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{coach.name}</p>
                    {coach.isSuperAdmin && (
                      <Badge className="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 text-[10px]">
                        Admin
                      </Badge>
                    )}
                    {!coach.neonAuthUserId && (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        Pending signup
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{coach.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm tabular-nums">{coach.ceoCount}</span>
                <span className="text-xs text-muted-foreground">CEOs</span>
              </div>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
