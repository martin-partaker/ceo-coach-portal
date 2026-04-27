/**
 * Wipe raw_inputs + ingestion_cursors so backfill re-evaluates everything
 * from scratch. Useful after seeding new CEOs or tweaking the matcher.
 *
 * Run: pnpm reset:ingestion
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { isNotNull } from 'drizzle-orm';
import {
  rawInputs,
  ingestionCursors,
  rawInputCeos,
  journalEntries,
  transcripts,
} from '../src/db/schema';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  // Delete projected rows first (only those that came from raw_inputs)
  const journalRows = await db
    .delete(journalEntries)
    .where(isNotNull(journalEntries.sourceRawInputId))
    .returning({ id: journalEntries.id });
  const transcriptRows = await db
    .delete(transcripts)
    .where(isNotNull(transcripts.sourceRawInputId))
    .returning({ id: transcripts.id });

  const linkRows = await db.delete(rawInputCeos).returning({ rawInputId: rawInputCeos.rawInputId });
  const rawRows = await db.delete(rawInputs).returning({ id: rawInputs.id });
  const cursorRows = await db.delete(ingestionCursors).returning({ source: ingestionCursors.source });

  console.log(`deleted journal_entries: ${journalRows.length}  (only projected ones)`);
  console.log(`deleted transcripts:     ${transcriptRows.length}  (only projected ones)`);
  console.log(`deleted raw_input_ceos:  ${linkRows.length}`);
  console.log(`deleted raw_inputs:      ${rawRows.length}`);
  console.log(`reset cursors:           ${cursorRows.length}`);
  console.log(
    `\nNote: ceos.profileJson, ceos.tenXGoal, cycles.monthlyReflection are NOT cleared\n      (they're column updates, not projector-owned rows). Re-projection overwrites them.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
