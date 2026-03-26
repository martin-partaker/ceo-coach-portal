import { createServerCaller } from '@/lib/trpc/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft } from 'lucide-react';
import { CycleInputForm } from '@/components/cycles/cycle-input-form';

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
  if (ceo.id !== ceoId) notFound();

  const coach = await api.coaches.getMe();

  const inputs = [
    !!cycle.monthlyGoals?.trim(),
    !!cycle.weeklyJournal1?.trim(),
    !!cycle.weeklyJournal2?.trim(),
    !!cycle.weeklyJournal3?.trim(),
    !!cycle.weeklyJournal4?.trim(),
    !!cycle.weeklyJournal5?.trim(),
    !!cycle.monthlyReflection?.trim(),
    !!cycle.zoomTranscript?.trim() || cycle.transcriptSkipped,
  ];
  const filledCount = inputs.filter(Boolean).length;

  return (
    <div className="space-y-8">
      {/* Header */}
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
          <Badge
            variant="secondary"
            className={filledCount === inputs.length
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-xs'
              : 'text-xs'
            }
          >
            {filledCount}/{inputs.length} inputs complete
          </Badge>
        </div>
      </div>

      {/* Input form */}
      <CycleInputForm cycle={cycle} ceoId={ceoId} hasZoomEmail={!!coach.zoomUserEmail} />
    </div>
  );
}
