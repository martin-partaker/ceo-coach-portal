import { createServerCaller } from '@/lib/trpc/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Calendar, CheckCircle2 } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { TenXGoalEditor } from '@/components/ceos/ten-x-goal-editor';
import { CeoDetailsEditor } from '@/components/ceos/ceo-details-editor';
import { CreateCycleDialog } from '@/components/ceos/create-cycle-dialog';

export const dynamic = 'force-dynamic';

export default async function CeoProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const api = await createServerCaller();

  let data;
  try {
    data = await api.ceos.get({ id });
  } catch {
    notFound();
  }

  const { ceo, cycles } = data;

  return (
    <div className="space-y-8">
      {/* Breadcrumbs + header */}
      <div>
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{ceo.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{ceo.name}</h1>
            {ceo.email && (
              <p className="mt-1 text-sm text-muted-foreground">{ceo.email}</p>
            )}
          </div>
          <CeoDetailsEditor ceo={ceo} />
        </div>
      </div>

      {/* 10x Goal */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">10x Goal</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <TenXGoalEditor ceoId={ceo.id} initialGoal={ceo.tenXGoal} updatedAt={ceo.tenXGoalUpdatedAt} />
        </CardContent>
      </Card>

      {/* Cycles */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">Sessions</h2>
          <CreateCycleDialog ceoId={ceo.id} />
        </div>

        {cycles.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Calendar className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-sm font-medium">No sessions yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Start the first coaching session for {ceo.name}.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <div className="divide-y divide-border">
              {cycles.map((cycle) => (
                <Link
                  key={cycle.id}
                  href={`/ceos/${ceo.id}/cycles/${cycle.id}`}
                  className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/50"
                >
                  <div>
                    <p className="text-sm font-medium">{cycle.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground font-mono">
                      Created {new Date(cycle.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <CycleStatusBadge cycle={cycle} hasReport={cycle.hasReport} />
                </Link>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function CycleStatusBadge({ cycle, hasReport }: { cycle: { monthlyGoals: string | null }; hasReport: boolean }) {
  if (hasReport) {
    return <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[11px]"><CheckCircle2 className="mr-1 h-3 w-3" />Email generated</Badge>;
  }
  if (cycle.monthlyGoals?.trim()) {
    return <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 text-[11px]">In progress</Badge>;
  }
  return <Badge variant="secondary" className="text-[11px]">New</Badge>;
}
