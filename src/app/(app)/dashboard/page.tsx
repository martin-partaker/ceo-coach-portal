import { auth } from '@/lib/auth/server';
import { db } from '@/db';
import { coaches, ceos, cycles, reports } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus, User, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type CycleStatus = 'no-cycle' | 'in-progress' | 'ready' | 'generated';

function getCycleStatus(
  latestCycle: { id: string; monthlyGoals: string | null; zoomTranscript: string | null; transcriptSkipped: boolean } | undefined,
  hasReport: boolean
): CycleStatus {
  if (!latestCycle) return 'no-cycle';
  if (hasReport) return 'generated';
  const hasGoals = !!latestCycle.monthlyGoals?.trim();
  const hasTranscript = !!latestCycle.zoomTranscript?.trim() || latestCycle.transcriptSkipped;
  if (hasGoals && hasTranscript) return 'ready';
  return 'in-progress';
}

const statusConfig: Record<CycleStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  'no-cycle': { label: 'No cycle', variant: 'outline' },
  'in-progress': { label: 'In progress', variant: 'secondary' },
  'ready': { label: 'Ready to generate', variant: 'default' },
  'generated': { label: 'Generated', variant: 'default' },
};

export default async function DashboardPage() {
  const { data: session } = await auth.getSession();
  if (!session?.user) redirect('/auth/sign-in');

  const [coach] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.neonAuthUserId, session.user.id))
    .limit(1);

  if (!coach) redirect('/auth/sign-in');

  // Fetch all CEOs for this coach with their latest cycle
  const coachCeos = await db
    .select()
    .from(ceos)
    .where(eq(ceos.coachId, coach.id))
    .orderBy(desc(ceos.createdAt));

  // Fetch latest cycle + report status for each CEO
  const ceoData = await Promise.all(
    coachCeos.map(async (ceo) => {
      const latestCycles = await db
        .select()
        .from(cycles)
        .where(eq(cycles.ceoId, ceo.id))
        .orderBy(desc(cycles.createdAt))
        .limit(1);

      const latestCycle = latestCycles[0];

      let hasReport = false;
      if (latestCycle) {
        const latestReports = await db
          .select({ id: reports.id })
          .from(reports)
          .where(eq(reports.cycleId, latestCycle.id))
          .limit(1);
        hasReport = latestReports.length > 0;
      }

      const status = getCycleStatus(latestCycle, hasReport);
      return { ceo, latestCycle, status };
    })
  );

  const missingCycle = ceoData.filter((d) => d.status === 'no-cycle');
  const inProgress = ceoData.filter((d) => d.status === 'in-progress');
  const readyToGenerate = ceoData.filter((d) => d.status === 'ready');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your CEOs</h1>
          <p className="text-sm text-muted-foreground">
            {coachCeos.length} coachee{coachCeos.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/ceos/new">
            <Plus className="mr-1.5 h-4 w-4" />
            Add CEO
          </Link>
        </Button>
      </div>

      {/* Attention needed banner */}
      {(missingCycle.length > 0 || inProgress.length > 0) && (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-950/20">
          <CardContent className="pt-4">
            <div className="flex gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="text-sm text-amber-800 dark:text-amber-300">
                <span className="font-medium">Needs attention: </span>
                {missingCycle.length > 0 && (
                  <span>{missingCycle.length} CEO{missingCycle.length !== 1 ? 's' : ''} without an active cycle. </span>
                )}
                {inProgress.length > 0 && (
                  <span>{inProgress.length} cycle{inProgress.length !== 1 ? 's' : ''} with missing inputs.</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* CEO list */}
      {ceoData.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <User className="mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium">No CEOs yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add your first coachee to get started
            </p>
            <Button asChild className="mt-4" size="sm">
              <Link href="/ceos/new">
                <Plus className="mr-1.5 h-4 w-4" />
                Add CEO
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {ceoData.map(({ ceo, latestCycle, status }) => {
            const { label, variant } = statusConfig[status];
            const href = `/ceos/${ceo.id}`;

            return (
              <Link key={ceo.id} href={href} className="block">
                <Card className="transition-colors hover:bg-muted/30">
                  <CardContent className="flex items-center justify-between py-4">
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
                        <span className="text-xs text-muted-foreground">
                          {latestCycle.label}
                        </span>
                      )}
                      <Badge
                        variant={variant}
                        className={cn(
                          status === 'generated' && 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
                          status === 'ready' && 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                        )}
                      >
                        {label}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {/* Quick stats */}
      {ceoData.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-1 pt-4">
              <CardTitle className="text-xs font-medium text-muted-foreground">Ready to generate</CardTitle>
            </CardHeader>
            <CardContent className="pb-4">
              <p className="text-2xl font-bold">{readyToGenerate.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1 pt-4">
              <CardTitle className="text-xs font-medium text-muted-foreground">In progress</CardTitle>
            </CardHeader>
            <CardContent className="pb-4">
              <p className="text-2xl font-bold">{inProgress.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1 pt-4">
              <CardTitle className="text-xs font-medium text-muted-foreground">Total CEOs</CardTitle>
            </CardHeader>
            <CardContent className="pb-4">
              <p className="text-2xl font-bold">{coachCeos.length}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
