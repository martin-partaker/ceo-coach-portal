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
    .select({
      id: cycles.id,
      ceoId: cycles.ceoId,
      teamId: cycles.teamId,
      label: cycles.label,
      periodStart: cycles.periodStart,
    })
    .from(cycles)
    .where(eq(cycles.id, cycleId))
    .limit(1);
  if (!cycle) return null;

  // The "previous month" is the cycle in the same engagement immediately
  // before this one by period. For TEAM cycles we MUST scope by teamId,
  // not ceoId: a team's canonical cycle can carry a different lead
  // member's ceoId each month (e.g. May's lead is Dave, June's is David),
  // so a ceoId filter silently skips months. Solo cycles scope by ceoId.
  // journal_entries link by cycleId, so a team cycle's query captures
  // every member's journals.
  const scope = cycle.teamId
    ? eq(cycles.teamId, cycle.teamId)
    : eq(cycles.ceoId, cycle.ceoId);
  const scoped = await db
    .select({
      id: cycles.id,
      label: cycles.label,
      periodStart: cycles.periodStart,
    })
    .from(cycles)
    .where(scope)
    .orderBy(asc(cycles.periodStart), asc(cycles.createdAt));
  // `period_start` is a `date` column → an ISO 'YYYY-MM-DD' string, which
  // sorts chronologically as a plain string comparison.
  const curStart = cycle.periodStart;
  // Most recent cycle whose period starts strictly before the current one.
  const prev =
    curStart === null
      ? null
      : ([...scoped]
          .reverse()
          .find(
            (c) =>
              c.id !== cycleId &&
              c.periodStart !== null &&
              c.periodStart < curStart,
          ) ?? null);

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
    // Clean, full-month labels derived from the cycle's actual period so
    // the header reads "June 2026" (not the stored short label "Jun
    // 2026") and matches the model-written minutes table below it.
    currentLabel: formatMonthLabel(cycle.periodStart, cycle.label),
    previousLabel: prev ? formatMonthLabel(prev.periodStart, prev.label) : null,
    rows,
  };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Turn a cycle's `period_start` (ISO 'YYYY-MM-DD') into a full "Month
 * YYYY" label. Falls back to the stored cycle label for custom/non-month
 * cycles or when the date is missing.
 */
function formatMonthLabel(periodStart: string | null, fallback: string): string {
  if (periodStart) {
    const m = /^(\d{4})-(\d{2})/.exec(periodStart);
    if (m) {
      const monthIdx = Number(m[2]) - 1;
      if (monthIdx >= 0 && monthIdx < 12) {
        return `${MONTH_NAMES[monthIdx]} ${m[1]}`;
      }
    }
  }
  return fallback;
}
