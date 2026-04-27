/**
 * One-shot cleanup: every existing pending_cycle row gets a monthly cycle
 * auto-created and is marked matched. Mirrors the new ingest behavior so the
 * historical backlog doesn't stay stuck in triage.
 *
 * Run: pnpm tsx --env-file=.env scripts/sweep-pending-cycle.ts
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { rawInputs } from '../src/db/schema';
import { ensureCycleForCeoAndDate } from '../src/lib/ingestion/match-cycle';
import { projectRawInput } from '../src/lib/ingestion/project';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  const rows = await db
    .select()
    .from(rawInputs)
    .where(eq(rawInputs.matchStatus, 'pending_cycle'));

  console.log(`Found ${rows.length} pending_cycle rows`);

  let resolved = 0;
  let skipped = 0;
  let createdCycles = 0;

  for (const r of rows) {
    if (!r.ceoId) {
      skipped++;
      continue;
    }
    const cycle = await ensureCycleForCeoAndDate({
      ceoId: r.ceoId,
      occurredAt: r.occurredAt,
    });
    if (cycle.created) createdCycles++;

    await db
      .update(rawInputs)
      .set({
        cycleId: cycle.cycleId,
        matchStatus: 'matched',
        matchConfidence: cycle.confident ? 100 : 75,
      })
      .where(eq(rawInputs.id, r.id));

    await projectRawInput(r.id);
    resolved++;
  }

  console.log(`Resolved ${resolved} rows · created ${createdCycles} new cycles · skipped ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
