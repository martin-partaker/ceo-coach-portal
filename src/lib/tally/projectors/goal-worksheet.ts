import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { ceos } from '@/db/schema';
import type { Projector } from './types';
import { extractTenXGoalFromWorksheet } from '@/lib/ai/extract-ten-x-goal';

/**
 * Project a 10x Goal Worksheet submission into ceos.tenXGoal.
 *
 * The worksheet's raw textContent is verbose Q&A ("Q: 1a. ... A: ...")
 * and we never want that as a CEO's stored 10x goal — it shows up in
 * coach UI and downstream prompts. So we run an LLM extraction over
 * the worksheet to produce a single concise goal sentence and store
 * that instead.
 *
 * Behaviour:
 *  - Skip when a more recent coach-set goal already exists.
 *  - If extraction returns null (LLM error or no confident 10x goal
 *    in the responses) we leave the existing value alone — fail-soft
 *    so we never clobber a manual entry on a transient model error.
 */
export const projectGoalWorksheet: Projector = async ({ rawInput, ceo }) => {
  const text = rawInput.textContent ?? '';
  if (!text) return;

  const lastUpdated = ceo.tenXGoalUpdatedAt;
  const submissionTime = rawInput.occurredAt;

  if (ceo.tenXGoal && lastUpdated && lastUpdated > submissionTime) {
    return; // coach has a newer value
  }

  const extracted = await extractTenXGoalFromWorksheet({
    ceoName: ceo.name,
    rawText: text,
  });
  if (!extracted) return;

  await db
    .update(ceos)
    .set({ tenXGoal: extracted, tenXGoalUpdatedAt: submissionTime })
    .where(eq(ceos.id, ceo.id));
};
