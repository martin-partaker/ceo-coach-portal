/**
 * Detect and repair projection rows whose `cycleId` no longer matches
 * their source rawInput's `cycleId`. These are orphans created by the
 * old transcript-projector cleanup logic (it skipped deletion when
 * `existing.length === targetCycleIds.length`, so a moved rawInput
 * left its old projection sitting on the previous cycle).
 *
 * Strategy: for every distinct sourceRawInputId across `transcripts`
 * and `journal_entries`, re-run `projectRawInput`. The fixed projectors
 * upsert + always-delete-out-of-membership, so a single re-projection
 * pass collapses orphans away. Idempotent.
 *
 * Run: pnpm cleanup:orphan-projections
 */
import 'dotenv/config';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db } from '../src/db';
import {
  transcripts as transcriptsTable,
  journalEntries,
  rawInputs,
  cycles,
} from '../src/db/schema';
import { projectRawInput } from '../src/lib/ingestion/project';

async function main() {
  const tIds = await db
    .selectDistinct({ id: transcriptsTable.sourceRawInputId })
    .from(transcriptsTable)
    .where(isNotNull(transcriptsTable.sourceRawInputId));
  const jIds = await db
    .selectDistinct({ id: journalEntries.sourceRawInputId })
    .from(journalEntries)
    .where(isNotNull(journalEntries.sourceRawInputId));

  const allIds = new Set<string>();
  for (const r of tIds) if (r.id) allIds.add(r.id);
  for (const r of jIds) if (r.id) allIds.add(r.id);

  console.log(`Re-projecting ${allIds.size} raw inputs to clear orphans…`);

  let ok = 0;
  let fail = 0;
  for (const id of allIds) {
    try {
      await projectRawInput(id);
      ok += 1;
    } catch (e) {
      fail += 1;
      console.error(`  fail ${id}`, e);
    }
  }

  console.log(`\nDone. ok=${ok} fail=${fail}`);

  // ── Monthly reflections: the projector writes to cycles.monthlyReflection
  // but never clears the OLD cycle when a rawInput moves cycles. Walk
  // every monthly_journal rawInput and clear the stale text on any
  // sibling cycle that still holds it.
  console.log('\nClearing stale monthlyReflection text on old cycles…');
  const monthlyJournals = await db
    .select({
      id: rawInputs.id,
      ceoId: rawInputs.ceoId,
      cycleId: rawInputs.cycleId,
      textContent: rawInputs.textContent,
    })
    .from(rawInputs)
    .where(eq(rawInputs.contentType, 'monthly_journal'));

  let cleared = 0;
  for (const r of monthlyJournals) {
    if (!r.ceoId || !r.cycleId || !r.textContent?.trim()) continue;

    // Find sibling cycles (same CEO, different cycle) whose
    // monthlyReflection text matches this rawInput's textContent.
    const stale = await db
      .select({ id: cycles.id, label: cycles.label })
      .from(cycles)
      .where(
        and(
          eq(cycles.ceoId, r.ceoId),
          ne(cycles.id, r.cycleId),
          eq(cycles.monthlyReflection, r.textContent),
        ),
      );

    for (const s of stale) {
      console.log(`  · clearing monthlyReflection on ${s.label}`);
      await db
        .update(cycles)
        .set({ monthlyReflection: null })
        .where(eq(cycles.id, s.id));
      cleared += 1;
    }
  }
  console.log(`Cleared ${cleared} stale monthlyReflection rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
