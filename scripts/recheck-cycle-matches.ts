/**
 * Re-evaluate every raw_input that was attached to a cycle by the old
 * lax cycle matcher (`matchConfidence < 100`). Now that
 * `findCycleForOccurredAt` is strict (occurredAt must be inside
 * [periodStart, periodEnd]), these need to either:
 *   - get bumped to confidence 100 if the strict match still hits the
 *     same cycle (rare but possible if the cycle window covers the
 *     date and the old "fallback" was just suboptimal); OR
 *   - get moved to a different cycle — either an existing one whose
 *     window contains the date, or a freshly auto-created monthly
 *     default for that calendar month.
 *
 * Re-projection is automatic: the weekly-journal / transcript / etc
 * projectors are keyed on `sourceRawInputId` so the projected row
 * (journal_entries / transcripts) follows the rawInput to its new
 * cycle.
 *
 * Run: pnpm recheck:cycles [--dry-run]
 */
import 'dotenv/config';
import { eq, and, lt, isNotNull } from 'drizzle-orm';
import { db } from '../src/db';
import { ceos, cycles, rawInputs } from '../src/db/schema';
import { ensureCycleForCeoAndDate } from '../src/lib/ingestion/match-cycle';
import { projectRawInput } from '../src/lib/ingestion/project';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Rechecking lax cycle matches${dryRun ? ' (dry run)' : ''}…`);

  const lax = await db
    .select()
    .from(rawInputs)
    .where(
      and(
        eq(rawInputs.matchStatus, 'matched'),
        isNotNull(rawInputs.ceoId),
        lt(rawInputs.matchConfidence, 100),
      ),
    );

  console.log(`  found ${lax.length} raw inputs with confidence < 100`);

  const stats = {
    total: lax.length,
    bumpedSameCycle: 0,
    movedExistingCycle: 0,
    movedAutoCreated: 0,
    failed: 0,
  };

  for (const r of lax) {
    if (!r.ceoId) {
      stats.failed++;
      continue;
    }
    const [ceo] = await db.select().from(ceos).where(eq(ceos.id, r.ceoId)).limit(1);
    if (!ceo) {
      stats.failed++;
      continue;
    }

    let newMatch;
    try {
      newMatch = await ensureCycleForCeoAndDate({
        ceoId: r.ceoId,
        occurredAt: r.occurredAt,
      });
    } catch (e) {
      console.error(`  · ${ceo.name} ${r.contentType} ${r.occurredAt.toISOString()}: match failed`, e);
      stats.failed++;
      continue;
    }

    const sameCycle = newMatch.cycleId === r.cycleId;
    let kind: 'bumped' | 'moved-existing' | 'moved-created';
    if (sameCycle) {
      kind = 'bumped';
      stats.bumpedSameCycle++;
    } else if (newMatch.created) {
      kind = 'moved-created';
      stats.movedAutoCreated++;
    } else {
      kind = 'moved-existing';
      stats.movedExistingCycle++;
    }

    const [oldCycle] = r.cycleId
      ? await db.select({ label: cycles.label }).from(cycles).where(eq(cycles.id, r.cycleId)).limit(1)
      : [];
    const [newCycle] = await db
      .select({ label: cycles.label })
      .from(cycles)
      .where(eq(cycles.id, newMatch.cycleId))
      .limit(1);

    console.log(
      `  · ${ceo.name} · ${r.contentType} · ${r.occurredAt.toISOString().slice(0, 10)} :: ${kind}`,
    );
    console.log(
      `      ${oldCycle?.label ?? '(none)'} → ${newCycle?.label ?? '(unknown)'}${newMatch.created ? ' [created]' : ''}`,
    );

    if (dryRun) continue;

    await db
      .update(rawInputs)
      .set({
        cycleId: newMatch.cycleId,
        matchConfidence: 100,
      })
      .where(eq(rawInputs.id, r.id));

    // Re-project so journal_entries / transcripts move to the new
    // cycle. Projectors are idempotent on sourceRawInputId.
    try {
      await projectRawInput(r.id);
    } catch (e) {
      console.error(`      re-projection failed`, e);
    }
  }

  console.log('\nDone.');
  console.log(JSON.stringify(stats, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
