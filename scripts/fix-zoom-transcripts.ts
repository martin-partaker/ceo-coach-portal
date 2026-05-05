/**
 * One-time fix: re-fetch Zoom transcripts using each row's UUID instead
 * of the (broken) shared numeric meeting ID. Background:
 *
 *   The cron + manual-import paths called `fetchTranscript(meeting.id, ...)`
 *   which hits `/meetings/{id}/recordings`. For recurring meetings (Personal
 *   Meeting Rooms, scheduled series) every occurrence shares one numeric
 *   meeting ID, so Zoom returned the LATEST occurrence's transcript every
 *   time — and we ended up storing that same transcript on every distinct
 *   UUID. Per-row participants/topic/uuid metadata is correct; only
 *   `text_content` (and the LLM classification derived from it) is wrong.
 *
 * What this script does, per row in `raw_inputs WHERE source='zoom'`:
 *   1. Skip rows with synthesized external IDs (`uuid:start_time`) — those
 *      came from the local-file backfill and already have the right text.
 *   2. Skip rows where `text_content IS NULL` (pending_short / no_transcript).
 *   3. Fetch the transcript by UUID via `fetchTranscriptByUuid`.
 *   4. If different from current `text_content`, update the row.
 *   5. With `--reclassify`, re-run the classifier on the corrected text
 *      and update `classification` + `payload_json.classification`.
 *   6. Re-project to the typed `transcripts` table for matched rows so
 *      `transcripts.content` matches.
 *
 * Defaults to dry-run. Pass `--apply` to write.
 *
 * Usage:
 *   pnpm fix:zoom-transcripts                         # dry-run summary
 *   pnpm fix:zoom-transcripts --apply                 # write transcripts only
 *   pnpm fix:zoom-transcripts --apply --reclassify    # also re-run LLM
 *   pnpm fix:zoom-transcripts --apply --limit=5       # cap rows processed
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { rawInputs } from '../src/db/schema';
import { fetchTranscriptByUuid } from '../src/lib/zoom/client';
import { classifyTranscript } from '../src/lib/ingestion/classify';
import { projectRawInput } from '../src/lib/ingestion/project';
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
  const apply = argv.includes('--apply');
  const reclassify = argv.includes('--reclassify');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  return { apply, reclassify, limit: Number.isFinite(limit) ? limit : null };
}

/**
 * Synthesized UUIDs from `backfill-zoom.ts` look like `${uuid}:${start_time}`.
 * Real Zoom UUIDs are pure base64 (`==` padding allowed) and never contain
 * a colon, so a colon is a reliable "this row came from local replay" signal.
 */
function isSyntheticExternalId(externalId: string): boolean {
  return externalId.includes(':');
}

interface RowSummary {
  id: string;
  uuid: string;
  topic: string;
  occurredAt: Date;
  oldLen: number;
  newLen: number | null;
  changed: boolean;
  reclassified: boolean;
  reprojected: boolean;
  note: string | null;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `→ fix-zoom-transcripts (apply=${flags.apply}, reclassify=${flags.reclassify}, limit=${flags.limit ?? 'all'})`
  );

  const rows = await db
    .select()
    .from(rawInputs)
    .where(eq(rawInputs.source, 'zoom'));

  console.log(`  found ${rows.length} zoom raw_inputs row(s)`);

  const candidates = rows.filter((r) => {
    if (isSyntheticExternalId(r.externalId)) return false;
    if (r.textContent == null) return false;
    return true;
  });

  console.log(
    `  ${candidates.length} candidate(s) after skipping synthetic external_ids and null text_content`
  );

  const target = flags.limit != null ? candidates.slice(0, flags.limit) : candidates;
  const summaries: RowSummary[] = [];
  const errors: Array<{ id: string; uuid: string; message: string }> = [];

  for (const row of target) {
    const payload = (row.payloadJson ?? {}) as ZoomPayload;
    const uuid = payload.meeting?.uuid;
    const topic = payload.meeting?.topic ?? '(no topic)';

    if (!uuid) {
      errors.push({ id: row.id, uuid: '(missing)', message: 'payload.meeting.uuid missing' });
      continue;
    }

    const summary: RowSummary = {
      id: row.id,
      uuid,
      topic,
      occurredAt: row.occurredAt,
      oldLen: row.textContent?.length ?? 0,
      newLen: null,
      changed: false,
      reclassified: false,
      reprojected: false,
      note: null,
    };

    try {
      const fetched = await fetchTranscriptByUuid(uuid);

      if (!fetched) {
        summary.note = 'no_transcript_returned';
        summaries.push(summary);
        continue;
      }

      summary.newLen = fetched.transcript.length;
      summary.changed = fetched.transcript !== row.textContent;

      if (!summary.changed) {
        summary.note = 'already_correct';
        summaries.push(summary);
        continue;
      }

      if (!flags.apply) {
        summary.note = 'would_update';
        summaries.push(summary);
        continue;
      }

      // 1. Update text_content
      const updateSet: Partial<typeof rawInputs.$inferInsert> = {
        textContent: fetched.transcript,
      };

      // 2. Optionally re-run the classifier on the corrected text. We only
      //    re-classify if the row had a real classification before AND has
      //    enough duration to bother (mirrors INGESTION_CONFIG threshold).
      let newClassification: unknown = null;
      if (
        flags.reclassify &&
        payload.meeting?.duration != null &&
        payload.meeting.duration >= 5
      ) {
        try {
          newClassification = await classifyTranscript({
            topic,
            participants: payload.participants ?? [],
            duration: payload.meeting.duration,
            transcriptText: fetched.transcript,
          });
          summary.reclassified = true;
        } catch (err) {
          summary.note = `reclassify_failed: ${err instanceof Error ? err.message : 'unknown'}`;
        }
      }

      if (newClassification) {
        const newPayload: ZoomPayload = {
          ...payload,
          classification: newClassification,
        };
        updateSet.payloadJson = newPayload as object;
        updateSet.classification = newClassification as object;
      }

      await db.update(rawInputs).set(updateSet).where(eq(rawInputs.id, row.id));

      // 3. Re-project to typed transcripts table for matched rows so
      //    transcripts.content reflects the corrected text. projectRawInput
      //    is idempotent and a no-op for non-matched rows.
      if (row.matchStatus === 'matched') {
        try {
          await projectRawInput(row.id);
          summary.reprojected = true;
        } catch (err) {
          summary.note = `reproject_failed: ${err instanceof Error ? err.message : 'unknown'}`;
        }
      }
    } catch (err) {
      errors.push({
        id: row.id,
        uuid,
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }

    summaries.push(summary);
  }

  // Report
  console.log('\n  per-row summary:');
  for (const s of summaries) {
    const date = s.occurredAt.toISOString().slice(0, 10);
    const marker = s.changed ? (flags.apply ? '✓ updated' : '· would update') : '· unchanged';
    const cls = s.reclassified ? ' +reclassify' : '';
    const proj = s.reprojected ? ' +reproject' : '';
    const lens = `${s.oldLen}→${s.newLen ?? '?'}`;
    const note = s.note ? ` [${s.note}]` : '';
    console.log(`    ${marker}${cls}${proj}  ${date}  ${lens.padEnd(13)} ${s.topic}${note}`);
  }

  const changedCount = summaries.filter((s) => s.changed).length;
  const reclassifiedCount = summaries.filter((s) => s.reclassified).length;
  const reprojectedCount = summaries.filter((s) => s.reprojected).length;
  const noTranscriptCount = summaries.filter((s) => s.note === 'no_transcript_returned').length;
  const alreadyCorrectCount = summaries.filter((s) => s.note === 'already_correct').length;

  console.log('\n  totals:');
  console.log(`    candidates       : ${target.length}`);
  console.log(`    text_content diff: ${changedCount}`);
  console.log(`    already correct  : ${alreadyCorrectCount}`);
  console.log(`    no transcript    : ${noTranscriptCount}`);
  console.log(`    reclassified     : ${reclassifiedCount}`);
  console.log(`    reprojected      : ${reprojectedCount}`);
  console.log(`    errors           : ${errors.length}`);

  if (errors.length > 0) {
    console.log('\n  errors:');
    for (const e of errors) {
      console.log(`    ✗ ${e.id} (${e.uuid}): ${e.message}`);
    }
  }

  if (!flags.apply) {
    console.log('\n  DRY RUN — re-run with --apply to write changes.');
  } else {
    console.log('\n✅ done');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
