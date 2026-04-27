import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { ceos, ceoEmailAliases, coaches } from '@/db/schema';
import type { Ceo } from '@/db/schema';
import { INGESTION_CONFIG } from './config';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFC');
}

export function isInternalEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  const domain = normalized.split('@')[1];
  if (!domain) return false;
  return INGESTION_CONFIG.internalEmailDomains.includes(domain);
}

export async function findCeoByEmail(email: string): Promise<Ceo | null> {
  const normalized = normalizeEmail(email);
  if (!normalized.includes('@')) return null;

  const [alias] = await db
    .select({ ceoId: ceoEmailAliases.ceoId })
    .from(ceoEmailAliases)
    .where(eq(ceoEmailAliases.email, normalized))
    .limit(1);

  if (!alias) return null;

  const [ceo] = await db.select().from(ceos).where(eq(ceos.id, alias.ceoId)).limit(1);
  return ceo ?? null;
}

export async function ensureAlias(ceoId: string, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized.includes('@')) return;

  await db
    .insert(ceoEmailAliases)
    .values({ ceoId, email: normalized })
    .onConflictDoNothing({ target: ceoEmailAliases.email });
}

/**
 * Ensure a coach record exists for the given internal (e.g. @partaker.com)
 * email. Auto-creates a coach stub when not found — the assumption is that
 * any internal-domain Zoom host is a coach, so we shouldn't drop their
 * transcripts on the floor for lack of a manual coach setup.
 *
 * The created coach has neonAuthUserId = null (they haven't signed up yet)
 * and isSuperAdmin = false. The super admin can edit name / promote / etc.
 * later from /admin.
 */
export async function ensureCoachByZoomEmail(args: {
  email: string;
  name?: string | null;
}): Promise<{ coachId: string; created: boolean }> {
  const normalized = normalizeEmail(args.email);
  if (!normalized.includes('@')) {
    throw new Error(`Invalid coach email: ${args.email}`);
  }

  // Try by zoomUserEmail first (the Zoom-side identity), then by primary email.
  let [existing] = await db
    .select({ id: coaches.id })
    .from(coaches)
    .where(eq(coaches.zoomUserEmail, normalized))
    .limit(1);

  if (!existing) {
    [existing] = await db
      .select({ id: coaches.id })
      .from(coaches)
      .where(eq(coaches.email, normalized))
      .limit(1);
  }

  if (existing) {
    return { coachId: existing.id, created: false };
  }

  // Derive a name: prefer Zoom-provided; fall back to email local-part.
  const fallbackName = (args.name?.trim() || normalized.split('@')[0])
    .replace(/[._-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const [created] = await db
    .insert(coaches)
    .values({
      email: normalized,
      name: fallbackName,
      zoomUserEmail: normalized,
      isSuperAdmin: false,
    })
    .returning({ id: coaches.id });

  return { coachId: created.id, created: true };
}
