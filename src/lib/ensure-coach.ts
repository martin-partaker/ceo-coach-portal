import { db } from '@/db';
import { coaches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Coach } from '@/db/schema';

/**
 * Ensures a coach row exists for the given Neon Auth user.
 * Handles:
 * 1. Coach already linked by neonAuthUserId → return it
 * 2. Coach pre-created by admin (email exists, neonAuthUserId is null) → link auth account
 * 3. No coach exists → create new row
 */
export async function ensureCoach(params: {
  neonAuthUserId: string;
  name: string;
  email: string;
}): Promise<Coach> {
  // Case 1: already linked by auth user ID
  const [byAuthId] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.neonAuthUserId, params.neonAuthUserId))
    .limit(1);

  if (byAuthId) return byAuthId;

  // Case 2: pre-created by admin (email exists, neonAuthUserId is null)
  const [byEmail] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.email, params.email))
    .limit(1);

  if (byEmail) {
    const [updated] = await db
      .update(coaches)
      .set({
        neonAuthUserId: params.neonAuthUserId,
        name: params.name || byEmail.name,
      })
      .where(eq(coaches.id, byEmail.id))
      .returning();
    return updated;
  }

  // Case 3: brand new coach
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
