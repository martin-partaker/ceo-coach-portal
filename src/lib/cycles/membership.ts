/**
 * Cycle membership rules for derived (date-range) attribution.
 *
 * The product allows overlapping cycles — e.g. a coach can have a regular
 * "Mar 2026" monthly cycle AND a "Feb–Jun 2026" quarterly retrospective
 * stretched over the same months. Inputs (journals, transcripts, action
 * items, raw inputs) keep their original `cycle_id` as the primary owner
 * (where edits anchor), but they ALSO show up in any other cycle of the
 * same CEO whose `[periodStart, periodEnd]` window contains the input's
 * effective date.
 *
 * Membership rule: an input belongs to a cycle iff
 *   input.cycleId === cycle.id          (direct ownership), OR
 *   cycle has both period dates AND input belongs to the same CEO AND
 *   the input's effective date sits inside [periodStart, periodEnd].
 *
 * If a cycle has no period dates, only direct ownership counts — there's
 * no range to overlap against, so the cycle stays "isolated" the way it
 * was before this feature.
 */

type DateOnly = string; // "YYYY-MM-DD"

export interface CycleRange {
  id: string;
  periodStart: DateOnly | null;
  periodEnd: DateOnly | null;
}

function toDateOnly(value: Date | string | null | undefined): DateOnly | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function cycleContainsDate(
  cycle: Pick<CycleRange, 'periodStart' | 'periodEnd'>,
  date: DateOnly | null,
): boolean {
  if (!cycle.periodStart || !cycle.periodEnd || !date) return false;
  return date >= cycle.periodStart && date <= cycle.periodEnd;
}

/**
 * Effective date of a journal entry. Prefers an explicit `entryDate`
 * (the user-picked day), then projects `weekNumber` onto the parent
 * cycle's `periodStart` for legacy rows that only have a week number,
 * and finally falls back to `createdAt` if neither is available.
 */
export function journalEffectiveDate(args: {
  entryDate?: DateOnly | null;
  weekNumber: number;
  parentPeriodStart: DateOnly | null;
  createdAt: Date;
}): DateOnly {
  if (args.entryDate) return args.entryDate.slice(0, 10);
  if (args.parentPeriodStart) {
    const start = new Date(`${args.parentPeriodStart}T00:00:00Z`);
    const projected = new Date(start.getTime() + (args.weekNumber - 1) * 7 * 86_400_000);
    return projected.toISOString().slice(0, 10);
  }
  return toDateOnly(args.createdAt) ?? args.createdAt.toISOString().slice(0, 10);
}

export function transcriptEffectiveDate(args: {
  recordedAt: Date | null;
  createdAt: Date;
}): DateOnly {
  return toDateOnly(args.recordedAt) ?? toDateOnly(args.createdAt)!;
}

export function actionItemEffectiveDate(args: {
  dueAt: DateOnly | null;
  createdAt: Date;
}): DateOnly {
  return args.dueAt ?? toDateOnly(args.createdAt)!;
}

export function rawInputEffectiveDate(args: { occurredAt: Date }): DateOnly {
  return toDateOnly(args.occurredAt)!;
}

/**
 * True iff `input` is visible in `cycle` — direct ownership OR
 * date-range overlap. The caller is responsible for confirming the
 * input belongs to the same CEO as the cycle (we don't re-check that
 * here so the helper can stay schema-agnostic).
 */
export function inputBelongsToCycle(
  input: { primaryCycleId: string; effectiveDate: DateOnly },
  cycle: Pick<CycleRange, 'id' | 'periodStart' | 'periodEnd'>,
): boolean {
  if (input.primaryCycleId === cycle.id) return true;
  return cycleContainsDate(cycle, input.effectiveDate);
}
