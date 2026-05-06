import 'server-only';
import { inArray } from 'drizzle-orm';
import { curriculum } from '@/db/schema';
import type { db as DbInstance } from '@/db';

/**
 * Drop suggestedResourceIds the model may have invented. Mirrors v1's
 * behaviour but lives here so the v2 module is self-contained.
 */
export async function sanitiseSuggestedResources(
  db: typeof DbInstance,
  ids: string[] | undefined,
): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  const candidates = ids
    .filter((id) => /^[0-9a-fA-F-]{36}$/.test(id))
    .slice(0, 5);
  if (candidates.length === 0) return [];
  const rows = await db
    .select({ id: curriculum.id })
    .from(curriculum)
    .where(inArray(curriculum.id, candidates));
  const valid = new Set(rows.map((r) => r.id));
  return candidates.filter((id) => valid.has(id));
}
