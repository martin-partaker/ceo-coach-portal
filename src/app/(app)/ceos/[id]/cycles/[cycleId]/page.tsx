import { createServerCaller } from '@/lib/trpc/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, CheckCircle2, Circle } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function CyclePage({
  params,
}: {
  params: Promise<{ id: string; cycleId: string }>;
}) {
  const { id: ceoId, cycleId } = await params;
  const api = await createServerCaller();

  let data;
  try {
    data = await api.cycles.get({ id: cycleId });
  } catch {
    notFound();
  }

  const { cycle, ceo } = data;

  // Verify the CEO matches the URL
  if (ceo.id !== ceoId) notFound();

  const inputs = [
    { label: 'Monthly goals', filled: !!cycle.monthlyGoals?.trim() },
    { label: 'Weekly journal 1', filled: !!cycle.weeklyJournal1?.trim() },
    { label: 'Weekly journal 2', filled: !!cycle.weeklyJournal2?.trim() },
    { label: 'Weekly journal 3', filled: !!cycle.weeklyJournal3?.trim() },
    { label: 'Weekly journal 4', filled: !!cycle.weeklyJournal4?.trim() },
    { label: 'Weekly journal 5', filled: !!cycle.weeklyJournal5?.trim() },
    { label: 'Monthly reflection', filled: !!cycle.monthlyReflection?.trim() },
    { label: 'Zoom transcript', filled: !!cycle.zoomTranscript?.trim() || cycle.transcriptSkipped },
  ];

  const filledCount = inputs.filter((i) => i.filled).length;

  return (
    <div className="space-y-8">
      {/* Back link + header */}
      <div>
        <Link
          href={`/ceos/${ceoId}`}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to {ceo.name}
        </Link>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{cycle.label}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Coaching cycle for {ceo.name}
            </p>
          </div>
          <Badge variant="secondary" className="text-xs">
            {filledCount}/{inputs.length} inputs
          </Badge>
        </div>
      </div>

      {/* Input completeness */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Cycle Inputs</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <div className="grid gap-2">
            {inputs.map(({ label, filled }) => (
              <div key={label} className="flex items-center gap-3 py-1">
                {filled ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/40" />
                )}
                <span className={`text-sm ${filled ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {label}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Full input editing will be available in the next update.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
