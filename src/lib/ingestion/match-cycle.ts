import 'server-only';
import { and, desc, eq, lte, gte } from 'drizzle-orm';
import { db } from '@/db';
import { cycles } from '@/db/schema';

export interface CycleMatch {
  cycleId: string;
  confident: boolean;
}

/**
 * Pick the cycle for a given CEO + occurrence date.
 *
 * - Confident match: occurredAt falls within [periodStart, periodEnd].
 * - Fallback match: most recent cycle whose periodStart <= occurredAt (UI flags for confirm).
 * - No match: returns null → caller marks raw_input as pending_cycle.
 */
export async function findCycleForOccurredAt(args: {
  ceoId: string;
  occurredAt: Date;
}): Promise<CycleMatch | null> {
  const occurredDate = args.occurredAt.toISOString().slice(0, 10);

  const [exact] = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(
        eq(cycles.ceoId, args.ceoId),
        lte(cycles.periodStart, occurredDate),
        gte(cycles.periodEnd, occurredDate)
      )
    )
    .orderBy(desc(cycles.periodStart))
    .limit(1);

  if (exact) {
    return { cycleId: exact.id, confident: true };
  }

  const [fallback] = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(and(eq(cycles.ceoId, args.ceoId), lte(cycles.periodStart, occurredDate)))
    .orderBy(desc(cycles.periodStart))
    .limit(1);

  if (fallback) {
    return { cycleId: fallback.id, confident: false };
  }

  return null;
}
