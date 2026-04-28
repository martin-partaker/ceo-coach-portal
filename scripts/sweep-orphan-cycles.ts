/**
 * Backfill cycleId for any matched raw_inputs that have a ceoId but no
 * cycleId. Most likely cause: rows assigned via earlier inbox.assignToCeo /
 * createCeoFromInput before those mutations started auto-attaching cycles.
 *
 * Run: pnpm tsx --env-file=.env scripts/sweep-orphan-cycles.ts
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, and, isNotNull, isNull } from 'drizzle-orm';
import { rawInputs } from '../src/db/schema';
import { ensureCycleForCeoAndDate } from '../src/lib/ingestion/match-cycle';
import { projectRawInput } from '../src/lib/ingestion/project';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  const orphans = await db
    .select()
    .from(rawInputs)
    .where(
      and(
        eq(rawInputs.matchStatus, 'matched'),
        isNotNull(rawInputs.ceoId),
        isNull(rawInputs.cycleId)
      )
    );

  console.log(`Found ${orphans.length} matched rows with no cycleId.`);

  let resolved = 0;
  let createdCycles = 0;
  let projected = 0;
  let errors = 0;

  for (const r of orphans) {
    if (!r.ceoId) continue;
    try {
      const cycle = await ensureCycleForCeoAndDate({
        ceoId: r.ceoId,
        occurredAt: r.occurredAt,
      });
      if (cycle.created) createdCycles++;

      await db
        .update(rawInputs)
        .set({
          cycleId: cycle.cycleId,
          matchConfidence: cycle.confident ? 100 : 75,
        })
        .where(eq(rawInputs.id, r.id));

      await projectRawInput(r.id);
      resolved++;
      projected++;
    } catch (err) {
      errors++;
      console.error(`  ✗ ${r.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `Resolved ${resolved} · created ${createdCycles} new cycles · projected ${projected} · errors ${errors}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
