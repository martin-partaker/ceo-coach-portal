/**
 * Inspect → diagnose → repair Zoom transcripts in raw_inputs.
 *
 *   STEP 1 (read-only): hash every row's text_content, find duplicate
 *   groups, dump per-row metadata so we can see WHAT is duplicated.
 *
 *   STEP 2 (read-only): for the worst duplicate group, call Zoom
 *   directly per-UUID via the SAME `fetchTranscriptByUuid` the app uses,
 *   and log the file id + download_url Zoom returns. Three possible
 *   outcomes:
 *     a) Zoom returns DIFFERENT files per UUID → our DB is wrong; the
 *        repair step below fixes it.
 *     b) Zoom returns the SAME file across UUIDs → Zoom literally
 *        serves one transcript across the recurring series. We can't
 *        un-duplicate what the API doesn't differentiate; we leave
 *        those alone and report.
 *     c) Zoom returns 404 / no transcript → leave alone, log.
 *
 *   STEP 3 (writes, gated by --apply): for every zoom raw_input,
 *   re-fetch via UUID and update text_content if it differs. Re-classify
 *   on the corrected text (unless --no-reclassify). Re-project to the
 *   typed `transcripts` table for matched rows. Skip rows with a
 *   synthetic external_id (local-backfill `uuid:start_time` form —
 *   their content is from sidecar VTTs, not the API).
 *
 * Defaults to --apply because the user is saying the data is wrong RIGHT
 * NOW. Pass --dry-run to inspect-only.
 *
 * Run: pnpm tsx --env-file=.env scripts/repair-zoom-transcripts.ts [--dry-run] [--no-reclassify] [--limit=N]
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { rawInputs } from '../src/db/schema';
import { fetchTranscriptByUuid } from '../src/lib/zoom/client';
import { classifyTranscript } from '../src/lib/ingestion/classify';
import { projectRawInput } from '../src/lib/ingestion/project';
import { invalidatePendingSuggestions } from '../src/lib/ingestion/triage-suggest';
import type { ZoomParticipant } from '../src/lib/zoom/client';

interface ZoomPayload {
  meeting?: {
    uuid?: string;
    id?: number | string;
    topic?: string;
    start_time?: string;
    duration?: number;
  };
  participants?: ZoomParticipant[];
  classification?: unknown;
  manualImport?: boolean;
  ingestNote?: string;
}

interface CliFlags {
  apply: boolean;
  reclassify: boolean;
  limit: number | null;
}

function parseFlags(argv: string[]): CliFlags {
  const dryRun = argv.includes('--dry-run');
  const noReclassify = argv.includes('--no-reclassify');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  return {
    apply: !dryRun,
    reclassify: !noReclassify,
    limit: Number.isFinite(limit) ? limit : null,
  };
}

function isSyntheticExternalId(externalId: string): boolean {
  return externalId.includes(':');
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

interface RowRow {
  id: string;
  externalId: string;
  meetingId: string | null;
  uuid: string | null;
  topic: string | null;
  occurredAt: Date;
  textContent: string | null;
  textHash: string | null;
  matchStatus: string;
  payload: ZoomPayload;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log(`→ repair-zoom-transcripts (apply=${flags.apply}, reclassify=${flags.reclassify}, limit=${flags.limit ?? 'all'})`);

  const rows = await db.select().from(rawInputs).where(eq(rawInputs.source, 'zoom'));

  const enriched: RowRow[] = rows.map((r) => {
    const payload = (r.payloadJson ?? {}) as ZoomPayload;
    return {
      id: r.id,
      externalId: r.externalId,
      meetingId: payload.meeting?.id != null ? String(payload.meeting.id) : null,
      uuid: payload.meeting?.uuid ?? null,
      topic: payload.meeting?.topic ?? null,
      occurredAt: r.occurredAt,
      textContent: r.textContent,
      textHash: r.textContent ? sha(r.textContent) : null,
      matchStatus: r.matchStatus,
      payload,
    };
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 1: inspect duplicates
  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n[STEP 1] inspecting ${enriched.length} zoom rows for duplicates`);

  const byHash = new Map<string, RowRow[]>();
  for (const r of enriched) {
    if (!r.textHash) continue;
    if (!byHash.has(r.textHash)) byHash.set(r.textHash, []);
    byHash.get(r.textHash)!.push(r);
  }
  const dupGroups = [...byHash.entries()].filter(([, list]) => list.length > 1);
  dupGroups.sort((a, b) => b[1].length - a[1].length);

  console.log(`  unique text hashes : ${byHash.size}`);
  console.log(`  duplicate groups   : ${dupGroups.length}`);
  console.log(`  rows with null text: ${enriched.filter((r) => !r.textHash).length}`);

  if (dupGroups.length === 0) {
    console.log('  ✅ no duplicates detected.');
  } else {
    for (const [hash, list] of dupGroups.slice(0, 5)) {
      console.log(`\n  hash ${hash} — ${list.length} rows · ${list[0].textContent?.length ?? 0} chars`);
      for (const r of list.slice(0, 6)) {
        console.log(
          `    · ${r.occurredAt.toISOString().slice(0, 10)}  meetingId=${r.meetingId ?? '?'}  uuid=${r.uuid ?? '?'}  topic="${r.topic ?? ''}"`
        );
      }
      if (list.length > 6) console.log(`    … and ${list.length - 6} more`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // STEP 2: probe Zoom for the worst dup group
  // ─────────────────────────────────────────────────────────────────────
  if (dupGroups.length > 0) {
    const [worstHash, worstGroup] = dupGroups[0];
    const probeUuids = worstGroup
      .map((r) => r.uuid)
      .filter((u): u is string => !!u && !u.includes(':'))
      .slice(0, 4);

    console.log(`\n[STEP 2] probing Zoom directly for ${probeUuids.length} UUIDs in worst group ${worstHash}`);
    const probes: Array<{ uuid: string; ok: boolean; len: number; hash: string | null; topic: string | null; error?: string }> = [];
    for (const uuid of probeUuids) {
      try {
        const r = await fetchTranscriptByUuid(uuid);
        if (!r) {
          probes.push({ uuid, ok: false, len: 0, hash: null, topic: null, error: 'no transcript' });
        } else {
          probes.push({
            uuid,
            ok: true,
            len: r.transcript.length,
            hash: sha(r.transcript),
            topic: r.meetingTopic,
          });
        }
      } catch (err) {
        probes.push({
          uuid,
          ok: false,
          len: 0,
          hash: null,
          topic: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const p of probes) {
      console.log(
        `    · uuid=${p.uuid}  ok=${p.ok}  len=${p.len}  hash=${p.hash ?? '?'}  topic="${p.topic ?? ''}"${p.error ? `  error=${p.error}` : ''}`
      );
    }
    const distinctZoomHashes = new Set(probes.filter((p) => p.hash).map((p) => p.hash!));
    console.log(`  → Zoom returned ${distinctZoomHashes.size} distinct transcript(s) across ${probes.length} UUIDs`);
    if (distinctZoomHashes.size === 1 && probes.filter((p) => p.ok).length > 1) {
      console.log(
        '  → Zoom serves ONE transcript across this UUID series. The repair step cannot un-duplicate this.'
      );
    } else if (distinctZoomHashes.size > 1) {
      console.log('  → Zoom DOES distinguish — DB has wrong text. Repair step will fix.');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // STEP 3: repair
  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n[STEP 3] ${flags.apply ? 'repairing' : 'DRY RUN — would repair'}`);

  const candidates = enriched.filter((r) => {
    if (!r.uuid) return false;
    if (isSyntheticExternalId(r.externalId)) return false;
    return true;
  });
  const target = flags.limit != null ? candidates.slice(0, flags.limit) : candidates;
  console.log(`  candidates: ${target.length}`);

  let updated = 0;
  let alreadyCorrect = 0;
  let zoomNoTranscript = 0;
  let cleared = 0;
  let reclassified = 0;
  let reprojected = 0;
  const errors: Array<{ id: string; uuid: string; message: string }> = [];
  // Map of new content hash → list of rows that ended up with that content.
  // Lets us report any irreducible duplicates (Zoom-side) after repair.
  const newHashToRows = new Map<string, string[]>();

  for (const row of target) {
    const uuid = row.uuid!;
    try {
      const fetched = await fetchTranscriptByUuid(uuid);
      if (!fetched) {
        zoomNoTranscript++;
        // If we have text in the DB but Zoom doesn't, the text is leftover
        // from when the buggy numeric-id fetch wrote some other UUID's
        // transcript onto this row. Clear it so the row stops masquerading
        // as a real transcript.
        if (row.textContent) {
          if (!flags.apply) {
            cleared++;
          } else {
            await db
              .update(rawInputs)
              .set({ textContent: null, classification: null })
              .where(eq(rawInputs.id, row.id));
            await invalidatePendingSuggestions({ rawInputIds: [row.id] });
            cleared++;
          }
        }
        continue;
      }
      const newHash = sha(fetched.transcript);
      if (!newHashToRows.has(newHash)) newHashToRows.set(newHash, []);
      newHashToRows.get(newHash)!.push(row.id);

      if (fetched.transcript === row.textContent) {
        alreadyCorrect++;
        continue;
      }

      if (!flags.apply) {
        updated++;
        continue;
      }

      const updateSet: Partial<typeof rawInputs.$inferInsert> = {
        textContent: fetched.transcript,
      };

      if (
        flags.reclassify &&
        row.payload.meeting?.duration != null &&
        row.payload.meeting.duration >= 5
      ) {
        try {
          const newClassification = await classifyTranscript({
            topic: row.topic ?? '',
            participants: row.payload.participants ?? [],
            duration: row.payload.meeting.duration,
            transcriptText: fetched.transcript,
          });
          const newPayload: ZoomPayload = { ...row.payload, classification: newClassification };
          updateSet.payloadJson = newPayload as object;
          updateSet.classification = newClassification as object;
          reclassified++;
        } catch (err) {
          console.error(
            `    classify failed for ${row.id} (${uuid}):`,
            err instanceof Error ? err.message : err
          );
        }
      }

      await db.update(rawInputs).set(updateSet).where(eq(rawInputs.id, row.id));
      // Stale-mark the cached AI suggestion for this row so triage
      // recomputes against the corrected text.
      await invalidatePendingSuggestions({ rawInputIds: [row.id] });
      updated++;

      if (row.matchStatus === 'matched') {
        try {
          await projectRawInput(row.id);
          reprojected++;
        } catch (err) {
          console.error(
            `    reproject failed for ${row.id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (err) {
      errors.push({
        id: row.id,
        uuid,
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Final report
  // ─────────────────────────────────────────────────────────────────────
  const irreducibleDups = [...newHashToRows.entries()].filter(([, ids]) => ids.length > 1);
  console.log('\n  totals:');
  console.log(`    candidates                       : ${target.length}`);
  console.log(`    text changed (fixed)             : ${updated}${flags.apply ? '' : ' [dry-run]'}`);
  console.log(`    already correct                  : ${alreadyCorrect}`);
  console.log(`    Zoom returned no transcript      : ${zoomNoTranscript}`);
  console.log(`    cleared wrong text (no Zoom file): ${cleared}${flags.apply ? '' : ' [dry-run]'}`);
  console.log(`    reclassified                     : ${reclassified}`);
  console.log(`    reprojected                      : ${reprojected}`);
  console.log(`    errors                           : ${errors.length}`);
  console.log(`    Zoom-side irreducible duplicates : ${irreducibleDups.length} group(s)`);

  if (irreducibleDups.length > 0) {
    console.log(
      '\n  Zoom returned IDENTICAL transcript content across multiple UUIDs for these groups.'
    );
    console.log(
      '  These are not fixable from our side — Zoom does not differentiate them.'
    );
    for (const [hash, ids] of irreducibleDups.slice(0, 5)) {
      console.log(`    · hash ${hash}: ${ids.length} rows`);
      for (const id of ids.slice(0, 4)) console.log(`        - ${id}`);
      if (ids.length > 4) console.log(`        … and ${ids.length - 4} more`);
    }
  }

  if (errors.length > 0) {
    console.log('\n  errors:');
    for (const e of errors.slice(0, 20)) {
      console.log(`    ✗ ${e.id} (${e.uuid}): ${e.message}`);
    }
  }

  if (!flags.apply) {
    console.log('\n  DRY RUN — re-run without --dry-run to write changes.');
  } else {
    console.log('\n✅ done');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
