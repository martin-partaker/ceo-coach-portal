import { createServerCaller } from '@/lib/trpc/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  ArrowLeft,
  Users,
  AlertCircle,
  TrendingUp,
  Clock,
  CheckCircle2,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type CycleStatus = 'no-cycle' | 'in-progress' | 'ready' | 'generated';

function getCycleStatus(
  latestCycle: { monthlyGoals: string | null; zoomTranscript: string | null; transcriptSkipped: boolean } | null,
  hasReport: boolean
): CycleStatus {
  if (!latestCycle) return 'no-cycle';
  if (hasReport) return 'generated';
  const hasGoals = !!latestCycle.monthlyGoals?.trim();
  const hasTranscript = !!latestCycle.zoomTranscript?.trim() || latestCycle.transcriptSkipped;
  if (hasGoals && hasTranscript) return 'ready';
  return 'in-progress';
}

const statusConfig: Record<CycleStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
  'no-cycle': { label: 'No cycle', variant: 'outline' },
  'in-progress': { label: 'In progress', variant: 'secondary' },
  'ready': { label: 'Ready', variant: 'default', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20' },
  'generated': { label: 'Generated', variant: 'default', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
};

export default async function ViewAsCoachPage({
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
    data = await api.admin.viewAsCoach({ coachId: id });
  } catch {
    notFound();
  }

  const { coach, ceos: coachCeos } = data;

  const ceoData = coachCeos.map(({ ceo, latestCycle, hasReport }) => {
    const status = getCycleStatus(latestCycle, hasReport);
    return { ceo, latestCycle, status };
  });

  const inProgress = ceoData.filter((d) => d.status === 'in-progress');
  const readyToGenerate = ceoData.filter((d) => d.status === 'ready');

  return (
    <div className="space-y-8">
      {/* Admin banner */}
      <div className="flex items-center gap-3 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3">
        <Eye className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        <span className="text-sm text-purple-800 dark:text-purple-300">
          Viewing as <span className="font-medium">{coach.name}</span>
        </span>
        <div className="flex-1" />
        <Link
          href={`/admin/coaches/${id}`}
          className="text-xs text-purple-600 hover:text-purple-800 dark:text-purple-400 dark:hover:text-purple-300 underline underline-offset-2"
        >
          Exit view-as
        </Link>
      </div>

      {/* Back link */}
      <Link
        href={`/admin/coaches/${id}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to coach detail
      </Link>

      {/* Dashboard header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {coach.name}&apos;s coachees and coaching cycles.
        </p>
      </div>

      {/* Stats */}
      {ceoData.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="flex items-center gap-4 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Users className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{ceoData.length}</p>
                <p className="text-xs text-muted-foreground">Total CEOs</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                <TrendingUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{readyToGenerate.length}</p>
                <p className="text-xs text-muted-foreground">Ready to generate</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
                <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{inProgress.length}</p>
                <p className="text-xs text-muted-foreground">In progress</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* CEO list */}
      {ceoData.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Users className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-sm font-medium">No CEOs yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This coach hasn&apos;t added any coachees.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">CEOs</CardTitle>
          </CardHeader>
          <Separator />
          <div className="divide-y divide-border">
            {ceoData.map(({ ceo, latestCycle, status }) => {
              const { label, variant, className } = statusConfig[status];

              return (
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
                    <Badge variant={variant} className={cn('text-[11px]', className)}>
                      {status === 'generated' && <CheckCircle2 className="mr-1 h-3 w-3" />}
                      {label}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
