import { and, eq } from 'drizzle-orm';
import { actionItems } from '@/db/schema';

type Db = {
  delete: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
};

const OWNER_VALUES = new Set(['CEO', 'Coach', 'Other'] as const);
type Owner = 'CEO' | 'Coach' | 'Other';

function normalizeOwner(raw: string | undefined): Owner {
  if (!raw) return 'CEO';
  const trimmed = raw.trim();
  if (OWNER_VALUES.has(trimmed as Owner)) return trimmed as Owner;
  // Tolerate lowercase / variants the model sometimes produces.
  const lower = trimmed.toLowerCase();
  if (lower === 'ceo') return 'CEO';
  if (lower === 'coach') return 'Coach';
  return 'Other';
}

function normalizeDueAt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export interface AiSuggestedActionItem {
  owner?: string;
  item?: string;
  dueAt?: string | null;
}

/**
 * Replace this cycle's AI-suggested-but-untouched action items with a fresh
 * batch from the model. Items the coach has already curated — anything that
 * is `reviewed = true`, has a non-`open` status, or wasn't AI-suggested in
 * the first place — are left alone. Returns the rows that were inserted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function refreshAiActionItems(db: any, cycleId: string, suggestions: AiSuggestedActionItem[]) {
  // Drop only AI-suggested rows that the coach hasn't engaged with yet.
  // (Drizzle: combine cycle scope + ai_suggested + status='open' + reviewed=false.)
  await db
    .delete(actionItems)
    .where(
      and(
        eq(actionItems.cycleId, cycleId),
        eq(actionItems.aiSuggested, true),
        eq(actionItems.status, 'open'),
        eq(actionItems.reviewed, false),
      ),
    );

  const rows = suggestions
    .map((s) => {
      const item = (s.item ?? '').trim();
      if (!item) return null;
      return {
        cycleId,
        owner: normalizeOwner(s.owner),
        item,
        dueAt: normalizeDueAt(s.dueAt),
        aiSuggested: true,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return [];

  return db.insert(actionItems).values(rows).returning();
}
