import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { cycles } from '@/db/schema';
import type { Projector } from './types';

/**
 * Project a Monthly Momentum Journal submission into cycles.monthlyReflection.
 * The full Q/A text is dropped in — easy for the AI prompt builder to pick up.
 * Does not overwrite a coach-edited reflection unless empty.
 */
export const projectMonthlyJournal: Projector = async ({ rawInput, cycle }) => {
  if (!cycle || !rawInput.cycleId) return;

  const text = rawInput.textContent ?? '';
  if (!text) return;

  // Only set if empty — coaches may have edited their own reflection.
  if ((cycle.monthlyReflection ?? '').trim().length > 0) return;

  await db.update(cycles).set({ monthlyReflection: text }).where(eq(cycles.id, rawInput.cycleId));
};
