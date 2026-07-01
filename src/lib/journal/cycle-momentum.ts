import 'server-only';
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { cycles, journalEntries } from '@/db/schema';
import { aggregateMomentum, MOMENTUM_METRICS } from './momentum-metrics';

/**
 * Momentum Check data for one cycle: the four weekly-journal averages for
 * the month, and — when the immediately-preceding cycle has journal
 * scores — the prior month too. Rendered in both the PDF and the on-screen
 * report so the coach and the CEO see the same numbers.
 *
 * Shared by the PDF route and the `reports.getMomentum` tRPC query so the
 * aggregation logic lives in exactly one place.
 */
export type CycleMomentum = {
  currentLabel: string;
  previousLabel: string | null;
  rows: Array<{
    key: string;
    label: string;
    current: { avg: number; color: 'green' | 'yellow' | 'red' } | null;
    previous: { avg: number; color: 'green' | 'yellow' | 'red' } | null;
  }>;
};

export async function getCycleMomentum(
  cycleId: string,
): Promise<CycleMomentum | null> {
  const [cycle] = await db
    .select({ id: cycles.id, ceoId: cycles.ceoId, label: cycles.label })
    .from(cycles)
    .where(eq(cycles.id, cycleId))
    .limit(1);
  if (!cycle) return null;

  // The "previous month" is the cycle immediately before this one for the
  // same (lead) CEO, ordered by period. Team cycles carry the lead CEO's
  // id so this walks the team's timeline correctly. journal_entries link
  // by cycleId, so a team cycle's query captures every member's journals.
  const ceoCycles = await db
    .select({
      id: cycles.id,
      label: cycles.label,
      periodStart: cycles.periodStart,
      createdAt: cycles.createdAt,
    })
    .from(cycles)
    .where(eq(cycles.ceoId, cycle.ceoId))
    .orderBy(asc(cycles.periodStart), asc(cycles.createdAt));
  const idx = ceoCycles.findIndex((c) => c.id === cycleId);
  const prev = idx > 0 ? ceoCycles[idx - 1] : null;

  const ids = [cycleId, ...(prev ? [prev.id] : [])];
  const journals = await db
    .select({ cycleId: journalEntries.cycleId, content: journalEntries.content })
    .from(journalEntries)
    .where(inArray(journalEntries.cycleId, ids));

  const curContents = journals
    .filter((j) => j.cycleId === cycleId)
    .map((j) => j.content ?? '');
  const prevContents = prev
    ? journals.filter((j) => j.cycleId === prev.id).map((j) => j.content ?? '')
    : [];

  const cur = aggregateMomentum(curContents);
  const prv = prev ? aggregateMomentum(prevContents) : null;
  const curMap = new Map((cur ?? []).map((r) => [r.key, r]));
  const prevMap = new Map((prv ?? []).map((r) => [r.key, r]));

  const rows = MOMENTUM_METRICS.filter(
    (m) => curMap.has(m.key) || prevMap.has(m.key),
  ).map((m) => {
    const c = curMap.get(m.key);
    const p = prevMap.get(m.key);
    return {
      key: m.key,
      label: m.label,
      current: c ? { avg: c.avg, color: c.color } : null,
      previous: p ? { avg: p.avg, color: p.color } : null,
    };
  });

  if (rows.length === 0) return null;
  return {
    currentLabel: cycle.label,
    previousLabel: prev?.label ?? null,
    rows,
  };
}
