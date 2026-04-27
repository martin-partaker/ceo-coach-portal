import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function AdminCeosPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  const rows = await api.admin.listAllCeos();

  // Group by coach for a tidier read
  const byCoach = new Map<
    string,
    { coach: (typeof rows)[number]['coach']; ceos: typeof rows }
  >();
  for (const r of rows) {
    const key = r.coach.id;
    if (!byCoach.has(key)) byCoach.set(key, { coach: r.coach, ceos: [] });
    byCoach.get(key)!.ceos.push(r);
  }
  const grouped = [...byCoach.values()].sort((a, b) =>
    a.coach.name.localeCompare(b.coach.name)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">All CEOs</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} CEO{rows.length === 1 ? '' : 's'} across {grouped.length} coach
            {grouped.length === 1 ? '' : 'es'}.
          </p>
        </div>
      </div>

      {grouped.map(({ coach, ceos }) => (
        <Card key={coach.id}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base font-medium">
              <Link
                href={`/admin/coaches/${coach.id}`}
                className="hover:underline"
              >
                {coach.name}
              </Link>
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {ceos.length} CEO{ceos.length === 1 ? '' : 's'}
              </span>
            </CardTitle>
            <p className="text-xs text-muted-foreground font-mono">
              {coach.email}
            </p>
          </CardHeader>
          <Separator />
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {ceos.map(({ ceo, cycleCount, latestCycle, hasReport, aliasEmails }) => (
                <Link
                  key={ceo.id}
                  href={`/ceos/${ceo.id}`}
                  className="flex items-center justify-between gap-4 px-6 py-3 transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{ceo.name}</p>
                      {ceo.tenXGoal && (
                        <Badge variant="outline" className="text-[10px]">
                          10x set
                        </Badge>
                      )}
                      {hasReport && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 text-[10px] text-emerald-700 dark:text-emerald-400"
                        >
                          report
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground font-mono">
                      {ceo.email ?? '(no primary email)'}
                      {aliasEmails.length > 1 && (
                        <span className="ml-2 text-muted-foreground/70">
                          +{aliasEmails.length - 1} alias
                          {aliasEmails.length - 1 === 1 ? '' : 'es'}
                        </span>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                    <div className="text-right">
                      <p className="tabular-nums">{cycleCount}</p>
                      <p className="text-[10px] uppercase tracking-wider">cycles</p>
                    </div>
                    {latestCycle && (
                      <div className="text-right">
                        <p className="font-mono">{latestCycle.label}</p>
                        <p className="text-[10px] text-muted-foreground/70">latest</p>
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      {grouped.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">No CEOs in the system yet.</p>
        </Card>
      )}
    </div>
  );
}
