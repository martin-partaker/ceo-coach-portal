import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { ceos } from '@/db/schema';
import type { Projector } from './types';

/**
 * Project a 10x Goal Worksheet submission into ceos.tenXGoal.
 * Only sets the goal if absent or older than the submission — never overwrites
 * a more recent coach-set goal.
 */
export const projectGoalWorksheet: Projector = async ({ rawInput, ceo }) => {
  const text = rawInput.textContent ?? '';
  if (!text) return;

  const lastUpdated = ceo.tenXGoalUpdatedAt;
  const submissionTime = rawInput.occurredAt;

  if (ceo.tenXGoal && lastUpdated && lastUpdated > submissionTime) {
    return; // coach has a newer value
  }

  await db
    .update(ceos)
    .set({ tenXGoal: text, tenXGoalUpdatedAt: submissionTime })
    .where(eq(ceos.id, ceo.id));
};
