/**
 * One-time wipe: clear every Zoom transcript so the operator can re-import
 * from scratch through the UI and validate the new UUID-based fetch path.
 *
 * Deletes, in order:
 *   1. `transcripts` rows that came from a Zoom raw_input (matched by
 *      sourceRawInputId; zoomMeetingId-only rows are also wiped as a
 *      belt-and-braces catch for any orphans).
 *   2. `raw_inputs` rows where source='zoom'. This cascades to
 *      `raw_input_ceos` via FK.
 *   3. `ingestion_cursors` rows for `zoom:%` sources so the cron
 *      starts from a clean cursor next run.
 *
 * Does NOT touch:
 *   - `cycles`, `ceos`, `coaches` — keeps your roster intact.
 *   - `journal_entries`, `action_items`, `reports` — these can be
 *     regenerated via the UI; not zoom-derived in the same way.
 *   - Tally raw_inputs or Tally cursors.
 *
 * Defaults to dry-run. Pass `--apply` to actually delete.
 *
 * Usage:
 *   pnpm wipe:zoom          # show what would be deleted
 *   pnpm wipe:zoom --apply  # actually delete
 */
import 'dotenv/config';
import { eq, sql, isNotNull, inArray } from 'drizzle-orm';
import { db } from '../src/db';
import { rawInputs, transcripts, ingestionCursors } from '../src/db/schema';

interface CliFlags {
  apply: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log(`→ wipe-zoom-transcripts (apply=${flags.apply})`);

  // 1. Count what's there.
  const zoomRawIdsRows = await db
    .select({ id: rawInputs.id })
    .from(rawInputs)
    .where(eq(rawInputs.source, 'zoom'));
  const zoomRawIds = zoomRawIdsRows.map((r) => r.id);

  const transcriptsByRawId =
    zoomRawIds.length > 0
      ? await db
          .select({ id: transcripts.id })
          .from(transcripts)
          .where(inArray(transcripts.sourceRawInputId, zoomRawIds))
      : [];

  const transcriptsByZoomMeetingId = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(isNotNull(transcripts.zoomMeetingId));

  // De-dupe (an orphan transcript with a zoom_meeting_id but no source link
  // shouldn't exist normally, but if it does we want to count it once).
  const transcriptIdsToDelete = new Set<string>();
  for (const t of transcriptsByRawId) transcriptIdsToDelete.add(t.id);
  for (const t of transcriptsByZoomMeetingId) transcriptIdsToDelete.add(t.id);

  const cursorRows = await db
    .select({ source: ingestionCursors.source })
    .from(ingestionCursors)
    .where(sql`${ingestionCursors.source} like 'zoom:%'`);

  console.log('\n  current state:');
  console.log(`    raw_inputs (source=zoom)        : ${zoomRawIds.length}`);
  console.log(`    transcripts → zoom raw_input   : ${transcriptsByRawId.length}`);
  console.log(`    transcripts with zoomMeetingId : ${transcriptsByZoomMeetingId.length}`);
  console.log(`    transcripts to delete (union)  : ${transcriptIdsToDelete.size}`);
  console.log(`    ingestion_cursors zoom:%        : ${cursorRows.length}`);
  if (cursorRows.length > 0) {
    for (const c of cursorRows) console.log(`        - ${c.source}`);
  }

  if (!flags.apply) {
    console.log('\n  DRY RUN — re-run with --apply to delete.');
    return;
  }

  // 2. Delete in dependency order.
  console.log('\n  deleting…');

  if (transcriptIdsToDelete.size > 0) {
    const ids = Array.from(transcriptIdsToDelete);
    const deleted = await db
      .delete(transcripts)
      .where(inArray(transcripts.id, ids))
      .returning({ id: transcripts.id });
    console.log(`    transcripts        : -${deleted.length}`);
  } else {
    console.log('    transcripts        : -0');
  }

  if (zoomRawIds.length > 0) {
    // raw_input_ceos cascades on raw_inputs.id. raw_inputs has no other
    // tables FK-pointing at it, so a single delete is sufficient.
    const deleted = await db
      .delete(rawInputs)
      .where(eq(rawInputs.source, 'zoom'))
      .returning({ id: rawInputs.id });
    console.log(`    raw_inputs (zoom)  : -${deleted.length}`);
  } else {
    console.log('    raw_inputs (zoom)  : -0');
  }

  if (cursorRows.length > 0) {
    const deleted = await db
      .delete(ingestionCursors)
      .where(sql`${ingestionCursors.source} like 'zoom:%'`)
      .returning({ source: ingestionCursors.source });
    console.log(`    zoom cursors       : -${deleted.length}`);
  } else {
    console.log('    zoom cursors       : -0');
  }

  console.log('\n✅ done — re-import via Integrations → Sync now (or per-cycle import dialog).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
