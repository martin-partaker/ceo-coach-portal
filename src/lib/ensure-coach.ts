import { db } from '@/db';
import { coaches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Coach } from '@/db/schema';

/**
 * Ensures a coach row exists for the given Neon Auth user.
 * Handles two cases:
 * 1. Coach already exists by neonAuthUserId — return it
 * 2. Coach was pre-created by admin (email exists, pending neonAuthUserId) — link the auth account
 * 3. No coach exists — create a new one
 */
export async function ensureCoach(params: {
  neonAuthUserId: string;
  name: string;
  email: string;
}): Promise<Coach> {
  // Case 1: already linked by auth user ID
  const [existing] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.neonAuthUserId, params.neonAuthUserId))
    .limit(1);

  if (existing) return existing;

  // Case 2: pre-created by admin (email exists with pending auth ID)
  const [byEmail] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.email, params.email))
    .limit(1);

  if (byEmail) {
    // Link the real auth user ID to the pre-created coach row
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

  // Case 3: brand new coach — create row
  const [created] = await db
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

  return created;
}
