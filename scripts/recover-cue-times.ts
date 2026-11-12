/**
 * Recover `transcripts.cue_times` from Zoom for transcripts that have none.
 *
 *   ( set -a; . ./.env.staging; set +a; pnpm tsx scripts/recover-cue-times.ts [--limit N] [--apply] )
 *
 * The local-archive backfill covered 146 of 257 transcripts. The other 111
 * were never downloaded as .vtt, so the only place their timings still exist
 * is Zoom, for as long as Zoom keeps the recording. This re-downloads each by
 * meeting UUID and keeps only the timings.
 *
 * What it reads and writes:
 *  - Zoom: read only. One recordings lookup and one file download per meeting.
 *  - Database: staging only (see staging-guard), and only the `cue_times`
 *    column, only where it is NULL. Text is never touched.
 *
 * It writes timings only when the transcript Zoom returns today is the same
 * text we stored. If Zoom has re-generated it, or the UUID now resolves to a
 * different occurrence of a recurring meeting, the lines no longer correspond
 * and the row is skipped and reported instead.
 *
 * Dry run by default. Sequential, with a pause between meetings: the Zoom
 * rate limits are per account and shared with production.
 *
 * Running this asks Zoom for an access token, and a Server-to-Server app has
 * one live token at a time — so it ends whatever token production holds.
 * Production recovers on its own once the retry in `src/lib/zoom/client.ts`
 * is deployed there. Until then, do not run it around production's Zoom cron
 * (10:00 UTC daily, see vercel.json).
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { fetchTranscriptByUuid } from '../src/lib/zoom/client';
import { assertRealSecret, assertStagingDatabase } from './staging-guard';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  const n = i >= 0 ? Number.parseInt(args[i + 1] ?? '', 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const PAUSE_MS = 400;

const lf = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const host = assertStagingDatabase();
  for (const k of ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']) {
    assertRealSecret(k);
  }
  const sql = neon(process.env.DATABASE_URL!);

  const rows = (await sql`
    SELECT DISTINCT ON (r.id)
           r.id AS raw_input_id, r.external_id AS uuid, r.occurred_at, t.content
    FROM transcripts t
    JOIN raw_inputs r ON r.id = t.source_raw_input_id
    WHERE t.cue_times IS NULL AND r.source = 'zoom'
    ORDER BY r.id, r.occurred_at DESC
  `) as unknown as {
    raw_input_id: string;
    uuid: string;
    occurred_at: string;
    content: string;
  }[];

  // Newest first: Zoom is likeliest to still hold the recent ones.
  rows.sort((a, b) => +new Date(b.occurred_at) - +new Date(a.occurred_at));
  const todo = rows.slice(0, LIMIT);

  console.log(`database: ${host}`);
  console.log(`${rows.length} recordings have no cue times; checking ${todo.length}`);

  const tally = { ready: 0, written: 0, gone: 0, noCues: 0, textDiffers: 0, errors: 0 };
  const oldestGone: string[] = [];

  for (const row of todo) {
    const day = new Date(row.occurred_at).toISOString().slice(0, 10);
    try {
      const fetched = await fetchTranscriptByUuid(row.uuid);
      if (!fetched) {
        tally.gone++;
        if (oldestGone.length < 5) oldestGone.push(day);
      } else if (!fetched.cueTimes) {
        tally.noCues++;
      } else if (
        fetched.transcript !== row.content &&
        lf(fetched.transcript) !== lf(row.content)
      ) {
        tally.textDiffers++;
        console.log(`  ${day} text differs from what is stored — skipped`);
      } else if (
        fetched.cueTimes.split(',').length !== row.content.split('\n').length
      ) {
        tally.textDiffers++;
        console.log(`  ${day} cue count does not match the stored lines — skipped`);
      } else {
        tally.ready++;
        if (APPLY) {
          await sql`
            UPDATE transcripts SET cue_times = ${fetched.cueTimes}
            WHERE source_raw_input_id = ${row.raw_input_id} AND cue_times IS NULL
          `;
          tally.written++;
        }
      }
    } catch (e) {
      tally.errors++;
      console.log(`  ${day} ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(PAUSE_MS);
  }

  console.log(
    `\n  ${tally.ready} verified against the stored text\n` +
      `  ${tally.gone} not on Zoom any more, or without a transcript file` +
      (oldestGone.length ? ` (e.g. ${oldestGone.join(', ')})` : '') +
      `\n  ${tally.noCues} on Zoom but without cue lines\n` +
      `  ${tally.textDiffers} text or line count differs — skipped\n` +
      `  ${tally.errors} errors`,
  );
  console.log(
    APPLY
      ? `\n${tally.written} recordings updated.`
      : '\nDry run. Re-run with --apply to write.',
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
