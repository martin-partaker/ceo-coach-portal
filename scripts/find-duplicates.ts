/**
 * Diagnose duplicate raw_inputs (zoom transcripts especially).
 * Read-only — reports findings, doesn't modify anything.
 *
 * Suspected sources:
 *  - Local backfill uses external_id = `${uuid}:${start_time}` (synthetic)
 *  - Live ingestion uses external_id = uuid (raw)
 *  → Same meeting can land twice, once per path.
 *
 * Run: pnpm exec tsx --env-file=.env scripts/find-duplicates.ts
 */
import 'dotenv/config';
import { db } from '../src/db';
import { rawInputs } from '../src/db/schema';

interface PayloadShape {
  meeting?: { uuid?: string; start_time?: string; topic?: string };
  uuid?: string;
  start_time?: string;
  topic?: string;
}

async function main() {
  const all = await db.select().from(rawInputs);
  const zoom = all.filter(r => r.source === 'zoom');
  const tally = all.filter(r => r.source === 'tally');

  console.log(`Total raw_inputs: ${all.length}  (zoom=${zoom.length}, tally=${tally.length})\n`);

  // === ZOOM ===
  // Group by canonical (uuid, start_time) extracted from payload, regardless of external_id format
  const byCanonical = new Map<string, typeof zoom>();
  for (const r of zoom) {
    const p = (r.payloadJson ?? {}) as PayloadShape;
    const meeting = p.meeting ?? p;
    const uuid = meeting.uuid ?? '';
    const start = meeting.start_time ?? '';
    const key = `${uuid}|${start}`;
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key)!.push(r);
  }

  const dupGroups = [...byCanonical.entries()].filter(([, rows]) => rows.length > 1);
  console.log(`=== ZOOM duplicates (same uuid+start_time, multiple rows) ===`);
  console.log(`Duplicate groups: ${dupGroups.length}`);
  console.log(`Extra rows (group_size - 1): ${dupGroups.reduce((s, [, rs]) => s + rs.length - 1, 0)}\n`);

  for (const [key, rows] of dupGroups.slice(0, 20)) {
    const [uuid, start] = key.split('|');
    const topic = ((rows[0].payloadJson ?? {}) as PayloadShape).topic
      ?? ((rows[0].payloadJson ?? {}) as PayloadShape).meeting?.topic
      ?? '(no topic)';
    console.log(`  ${rows.length}x  ${start.slice(0,10)}  ${topic}`);
    for (const r of rows) {
      const isSynthetic = r.externalId.includes(':');
      console.log(`     · external_id=${r.externalId.slice(0, 50)}${r.externalId.length > 50 ? '…' : ''}  status=${r.matchStatus}  ${isSynthetic ? '(synthetic)' : '(raw uuid)'}  ceo=${r.ceoId?.slice(0,8) ?? 'none'}`);
    }
  }
  if (dupGroups.length > 20) console.log(`  ... +${dupGroups.length - 20} more dup groups`);

  // === Cross-pattern check: same UUID prefix in two external_id formats ===
  console.log(`\n=== ZOOM external_id format mix ===`);
  const synthetic = zoom.filter(r => r.externalId.includes(':')).length;
  const raw = zoom.filter(r => !r.externalId.includes(':')).length;
  console.log(`  synthetic (uuid:start): ${synthetic}`);
  console.log(`  raw (uuid only):        ${raw}`);

  // === TALLY ===
  console.log(`\n=== TALLY duplicates (by external_id collisions) ===`);
  const tallyById = new Map<string, typeof tally>();
  for (const r of tally) {
    if (!tallyById.has(r.externalId)) tallyById.set(r.externalId, []);
    tallyById.get(r.externalId)!.push(r);
  }
  const tallyDups = [...tallyById.entries()].filter(([, rs]) => rs.length > 1);
  console.log(`  rows: ${tally.length}, unique external_ids: ${tallyById.size}, dup groups: ${tallyDups.length}`);

  // Tally by (formId, submissionId) from payload
  const tallyByLogical = new Map<string, typeof tally>();
  for (const r of tally) {
    const p = (r.payloadJson ?? {}) as Record<string, unknown>;
    const formId = (p as { formId?: string; form_id?: string }).formId ?? (p as { form_id?: string }).form_id ?? '';
    const subId = (p as { submissionId?: string; id?: string }).submissionId ?? (p as { id?: string }).id ?? '';
    const key = `${formId}|${subId}`;
    if (!tallyByLogical.has(key)) tallyByLogical.set(key, []);
    tallyByLogical.get(key)!.push(r);
  }
  const tallyLogicalDups = [...tallyByLogical.entries()].filter(([, rs]) => rs.length > 1);
  console.log(`  by (formId,submissionId) groups with >1: ${tallyLogicalDups.length}`);
  for (const [key, rows] of tallyLogicalDups.slice(0, 5)) {
    console.log(`     ${rows.length}x  ${key}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
