/**
 * Delete zoom raw_inputs that came from local-cache replay (external_id
 * format `${uuid}:${start_time}`), keeping the canonical live-pulled rows
 * (external_id = raw uuid).
 *
 * Pass --dry-run to preview without deleting.
 *
 * Run: pnpm exec tsx --env-file=.env scripts/cleanup-synthetic-rawinputs.ts [--dry-run]
 */
import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db';
import { rawInputs } from '../src/db/schema';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`→ ${dryRun ? 'DRY-RUN' : 'EXECUTING'} cleanup of synthetic zoom raw_inputs\n`);

  const allZoom = await db
    .select({ id: rawInputs.id, externalId: rawInputs.externalId, source: rawInputs.source })
    .from(rawInputs)
    .where(eq(rawInputs.source, 'zoom'));

  const synthetic = allZoom.filter(r => r.externalId.includes(':'));
  const rawUuids = new Set(allZoom.filter(r => !r.externalId.includes(':')).map(r => r.externalId));

  const toDelete: string[] = [];
  const orphans: string[] = [];

  for (const r of synthetic) {
    const baseUuid = r.externalId.split(':')[0];
    if (rawUuids.has(baseUuid)) {
      toDelete.push(r.id);
    } else {
      orphans.push(r.id);
    }
  }

  console.log(`zoom rows total:           ${allZoom.length}`);
  console.log(`  synthetic (uuid:start):  ${synthetic.length}`);
  console.log(`  raw (uuid only):         ${rawUuids.size}`);
  console.log(`  → to delete (synthetic with live counterpart): ${toDelete.length}`);
  console.log(`  → orphan synthetic (no live counterpart):      ${orphans.length}\n`);

  if (orphans.length > 0) {
    console.log(`⚠ ${orphans.length} synthetic row(s) have NO live counterpart — keeping them for now:`);
    for (const id of orphans.slice(0, 5)) {
      const [row] = await db.select().from(rawInputs).where(eq(rawInputs.id, id)).limit(1);
      console.log(`     · ${row?.externalId.slice(0, 60)}`);
    }
    console.log();
  }

  if (toDelete.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  if (dryRun) {
    console.log(`(dry-run) would delete ${toDelete.length} rows`);
    return;
  }

  // Delete in batches to keep the IN-list manageable
  const BATCH = 100;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const slice = toDelete.slice(i, i + BATCH);
    const result = await db.delete(rawInputs).where(inArray(rawInputs.id, slice)).returning({ id: rawInputs.id });
    deleted += result.length;
  }

  console.log(`✅ Deleted ${deleted} synthetic raw_inputs (raw_input_ceos cascade-deleted automatically)`);

  // Confirm
  const after = await db.select().from(rawInputs).where(eq(rawInputs.source, 'zoom'));
  console.log(`\nzoom rows remaining: ${after.length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
