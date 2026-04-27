import { and, desc, eq, lte, gte } from 'drizzle-orm';
import { db } from '@/db';
import { cycles } from '@/db/schema';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

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

/**
 * Get or create a cycle that contains the given date for this CEO.
 * - If a cycle covers the date exactly → use it (no creation).
 * - Else if any cycle exists (fallback period) → use it (avoid duplicates).
 * - Else → create a monthly cycle for the date's calendar month.
 *
 * Used when an exact-email Tally match resolves to a CEO who has no cycles
 * yet (newly created via the inbox). Bypasses the manual triage step.
 */
export async function ensureCycleForCeoAndDate(args: {
  ceoId: string;
  occurredAt: Date;
}): Promise<{ cycleId: string; confident: boolean; created: boolean }> {
  const existing = await findCycleForOccurredAt(args);
  if (existing) {
    return { ...existing, created: false };
  }

  // No cycle at all — create a monthly default.
  const d = args.occurredAt;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const periodStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const label = `${MONTH_NAMES[month]} ${year}`;

  const [created] = await db
    .insert(cycles)
    .values({
      ceoId: args.ceoId,
      label,
      periodStart,
      periodEnd,
    })
    .returning({ id: cycles.id });

  return { cycleId: created.id, confident: true, created: true };
}
