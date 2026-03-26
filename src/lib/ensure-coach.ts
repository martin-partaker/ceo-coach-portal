import { db } from '@/db';
import { coaches } from '@/db/schema';
import type { Coach } from '@/db/schema';

/**
 * Ensures a coach row exists for the given Neon Auth user.
 * Called server-side on first authenticated page load.
 */
export async function ensureCoach(params: {
  neonAuthUserId: string;
  name: string;
  email: string;
}): Promise<Coach> {
  // This function can be called concurrently during navigation/render.
  // Use an upsert to avoid unique constraint races.
  const [coach] = await db
    .insert(coaches)
    .values({
      neonAuthUserId: params.neonAuthUserId,
      name: params.name || params.email,
      email: params.email,
    })
    .onConflictDoUpdate({
      target: coaches.neonAuthUserId,
      set: {
        name: params.name || params.email,
        email: params.email,
      },
    })
    .returning();

  return coach;
}
