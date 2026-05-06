import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { cycles } from '@/db/schema';
import type { Projector } from './types';

/**
 * Project a Monthly Momentum Journal submission into cycles.monthlyReflection.
 * The full Q/A text is dropped in — easy for the AI prompt builder to pick up.
 *
 * Two safeguards:
 *  - Doesn't overwrite a coach-edited reflection on the destination cycle
 *    (only writes when the destination is empty).
 *  - Clears stale text from any SIBLING cycle of the same CEO whose
 *    `monthlyReflection` still matches this rawInput's `textContent`.
 *    Without this, moving a rawInput from one cycle to another leaves
 *    the old cycle's reflection populated with the moved text — exactly
 *    how May reflections were leaking into April cycles.
 */
export const projectMonthlyJournal: Projector = async ({ rawInput, cycle, ceo }) => {
  if (!cycle || !rawInput.cycleId) return;

  const text = rawInput.textContent ?? '';
  if (!text) return;

  // Clear stale matches on any other cycle of the same CEO. We match on
  // text equality so a coach-rewritten reflection on the old cycle is
  // preserved (the equality check fails and we leave it alone).
  await db
    .update(cycles)
    .set({ monthlyReflection: null })
    .where(
      and(
        eq(cycles.ceoId, ceo.id),
        ne(cycles.id, rawInput.cycleId),
        eq(cycles.monthlyReflection, text),
      ),
    );

  // Only set on the destination if it's empty — coaches may have edited.
  if ((cycle.monthlyReflection ?? '').trim().length > 0) return;

  await db
    .update(cycles)
    .set({ monthlyReflection: text })
    .where(eq(cycles.id, rawInput.cycleId));
};
