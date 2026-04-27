import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { ceos, ceoEmailAliases } from '@/db/schema';
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
