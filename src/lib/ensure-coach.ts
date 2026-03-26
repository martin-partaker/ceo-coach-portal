import { db } from '@/db';
import { coaches } from '@/db/schema';
import { eq } from 'drizzle-orm';
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
  const existing = await db
    .select()
    .from(coaches)
    .where(eq(coaches.neonAuthUserId, params.neonAuthUserId))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(coaches)
    .values({
      neonAuthUserId: params.neonAuthUserId,
      name: params.name || params.email,
      email: params.email,
    })
    .returning();

  return created;
}
