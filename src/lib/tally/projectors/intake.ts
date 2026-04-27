import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { ceos } from '@/db/schema';
import type { Projector } from './types';

/**
 * Project an Intake Survey submission into ceos.profileJson.
 * Stores the entire submission payload as a JSONB blob for AI prompt context.
 * Overwrites any prior intake — there is one canonical intake per CEO.
 */
export const projectIntake: Projector = async ({ rawInput, ceo }) => {
  await db
    .update(ceos)
    .set({ profileJson: rawInput.payloadJson as object })
    .where(eq(ceos.id, ceo.id));
};
