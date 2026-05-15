import { and, desc, eq, isNull, lte, gte } from 'drizzle-orm';
import { db } from '@/db';
import { ceos, cycles } from '@/db/schema';

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
 * Team-aware:
 *  - If the CEO is in a coaching team, we look for a cycle tagged with
 *    that teamId whose [periodStart, periodEnd] covers the date. ALL
 *    members of the team share one cycle per period.
 *  - If not in a team, we look for a per-CEO cycle (legacy / solo).
 *
 * Strict membership: occurredAt MUST fall inside [periodStart, periodEnd]
 * of an existing cycle. If no cycle's window contains the date we
 * return null — the caller (ensureCycleForCeoAndDate) decides whether
 * to create a fresh monthly cycle or hand off to manual triage. We
 * removed the older "use the most recent prior cycle as a sloppy
 * fallback" branch on 2026-05-06 because it was attaching May
 * submissions to April cycles (and similar boundary-spanning cases),
 * polluting the AI's view of a cycle's inputs.
 */
export async function findCycleForOccurredAt(args: {
  ceoId: string;
  occurredAt: Date;
}): Promise<CycleMatch | null> {
  const occurredDate = args.occurredAt.toISOString().slice(0, 10);

  // Resolve the CEO's team so we can pick the right cycle subject.
  // For team members the cycle is keyed by `teamId`, not `ceoId`.
  const [ceo] = await db
    .select({ teamId: ceos.teamId })
    .from(ceos)
    .where(eq(ceos.id, args.ceoId))
    .limit(1);
  const teamId = ceo?.teamId ?? null;

  const subjectFilter = teamId
    ? eq(cycles.teamId, teamId)
    : and(eq(cycles.ceoId, args.ceoId), isNull(cycles.teamId));

  const [exact] = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(
        subjectFilter,
        lte(cycles.periodStart, occurredDate),
        gte(cycles.periodEnd, occurredDate),
      ),
    )
    .orderBy(desc(cycles.periodStart))
    .limit(1);

  if (exact) {
    return { cycleId: exact.id, confident: true };
  }

  return null;
}

/**
 * Get or create a cycle that contains the given date for this CEO.
 *  - If a cycle covers the date exactly → use it (no creation).
 *  - Else → create a monthly cycle for the date's calendar month.
 *
 * Team-aware: when the CEO is in a team, the new cycle gets the team's
 * `teamId` so every member's future input lands on the same cycle and
 * the report generator fans out across the whole team's inputs.
 */
export async function ensureCycleForCeoAndDate(args: {
  ceoId: string;
  occurredAt: Date;
}): Promise<{ cycleId: string; confident: boolean; created: boolean }> {
  const existing = await findCycleForOccurredAt(args);
  if (existing) {
    return { ...existing, created: false };
  }

  // Resolve the CEO's team (same lookup the finder did — keeping it
  // local here avoids exposing the team-id off the finder's return).
  const [ceo] = await db
    .select({ teamId: ceos.teamId })
    .from(ceos)
    .where(eq(ceos.id, args.ceoId))
    .limit(1);
  const teamId = ceo?.teamId ?? null;

  // No cycle at all — create a monthly default. For team members the
  // new cycle is tagged with teamId; ceoId stays pointing at the
  // requesting member as the cycle's "lead" (backwards-compat with
  // every query that joins cycles → ceos via ceoId).
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
      teamId,
      label,
      periodStart,
      periodEnd,
    })
    .returning({ id: cycles.id });

  return { cycleId: created.id, confident: true, created: true };
}

