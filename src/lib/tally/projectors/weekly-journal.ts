import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { journalEntries } from '@/db/schema';
import type { Projector } from './types';

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

function computeWeekNumber(occurredAt: Date, periodStart: string | null): number {
  if (!periodStart) return 1;
  const start = new Date(periodStart).getTime();
  const occurred = occurredAt.getTime();
  if (occurred < start) return 1;
  const idx = Math.floor((occurred - start) / MS_PER_WEEK) + 1;
  return Math.max(1, Math.min(idx, 5));
}

export const projectWeeklyJournal: Projector = async ({ rawInput, cycle }) => {
  if (!cycle || !rawInput.cycleId) return;

  const weekNumber = computeWeekNumber(rawInput.occurredAt, cycle.periodStart);
  const title = `Week ${weekNumber}`;
  const content = rawInput.textContent ?? '';

  // For team cycles, stamp which member authored the journal so the
  // v2 prompt can attribute the entry correctly ("David's Week 2 …"
  // vs "Dave's Week 2 …"). The authoring CEO is the rawInput's primary
  // ceoId — that's the email/account that submitted the form. On solo
  // cycles this still gets populated but the team-aware renderer only
  // surfaces the byline when team mode is on.
  const authoredByCeoId = rawInput.ceoId ?? null;

  const [existing] = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(eq(journalEntries.sourceRawInputId, rawInput.id))
    .limit(1);

  if (existing) {
    await db
      .update(journalEntries)
      .set({
        cycleId: rawInput.cycleId,
        authoredByCeoId,
        weekNumber,
        title,
        content,
      })
      .where(eq(journalEntries.id, existing.id));
    return;
  }

  await db.insert(journalEntries).values({
    cycleId: rawInput.cycleId,
    authoredByCeoId,
    weekNumber,
    title,
    content,
    sourceRawInputId: rawInput.id,
  });
};
