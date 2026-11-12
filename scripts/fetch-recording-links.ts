/**
 * Store, for each audited recording, the Zoom page where it can be watched.
 *
 *   ( set -a; . ./.env.staging; set +a; pnpm tsx scripts/fetch-recording-links.ts [--all] [--limit N] [--apply] )
 *
 * The audit and transcript screens show "Open the recording in Zoom". The
 * link was never kept at ingestion, so for recordings already in the
 * database the only place it exists is Zoom. New recordings keep it from the
 * start (see `ingest-zoom.ts`).
 *
 * What it reads and writes:
 *  - Zoom: read only. One recordings lookup per meeting, no file download.
 *  - Database: staging only (see staging-guard), and only one key —
 *    `raw_inputs.payload_json.meeting.share_url` — only where it is missing.
 *    No schema change. Transcripts and audits are never touched.
 *
 * By default only recordings that have an audit; `--all` for every Zoom
 * transcript. The passcode of a protected recording is NOT stored: a link
 * carrying it would open the video for anyone holding the link. The script
 * reports how many recordings ask for one, so that can be decided knowingly.
 *
 * Dry run by default. Sequential, with a pause between meetings.
 *
 * Same caution as recover-cue-times.ts: asking Zoom for a token ends whatever
 * token production holds, so do not run this around production's Zoom cron
 * (10:00 UTC daily) until the retry in `src/lib/zoom/client.ts` is live there.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { fetchRecordingShareUrl } from '../src/lib/zoom/client';
import { zoomRecordingUrl } from '../src/lib/audit/contract';
import { assertRealSecret, assertStagingDatabase } from './staging-guard';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  const n = i >= 0 ? Number.parseInt(args[i + 1] ?? '', 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const PAUSE_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { raw_input_id: string; uuid: string; occurred_at: string };

async function main() {
  const host = assertStagingDatabase();
  for (const k of ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']) {
    assertRealSecret(k);
  }
  const sql = neon(process.env.DATABASE_URL!);

  const rows = (ALL
    ? await sql`
        SELECT DISTINCT r.id AS raw_input_id, r.external_id AS uuid, r.occurred_at
        FROM transcripts t
        JOIN raw_inputs r ON r.id = t.source_raw_input_id
        WHERE r.source = 'zoom' AND (r.payload_json -> 'meeting') IS NOT NULL
          AND (r.payload_json -> 'meeting' ->> 'share_url') IS NULL`
    : await sql`
        SELECT DISTINCT r.id AS raw_input_id, r.external_id AS uuid, r.occurred_at
        FROM transcripts t
        JOIN raw_inputs r ON r.id = t.source_raw_input_id
        WHERE r.source = 'zoom' AND (r.payload_json -> 'meeting') IS NOT NULL
          AND (r.payload_json -> 'meeting' ->> 'share_url') IS NULL
          AND EXISTS (SELECT 1 FROM transcript_audits a WHERE a.transcript_id = t.id)`
  ) as unknown as Row[];

  // Newest first: Zoom is likeliest to still hold the recent ones.
  rows.sort((a, b) => +new Date(b.occurred_at) - +new Date(a.occurred_at));
  const todo = rows.slice(0, LIMIT);

  console.log(`database: ${host}`);
  console.log(
    `${rows.length} ${ALL ? 'Zoom' : 'audited'} recordings have no link stored; checking ${todo.length}`,
  );

  const tally = { ready: 0, written: 0, gone: 0, noLink: 0, notZoom: 0, passcode: 0, errors: 0 };
  const hosts = new Set<string>();
  const goneDays: string[] = [];

  for (const row of todo) {
    const day = new Date(row.occurred_at).toISOString().slice(0, 10);
    try {
      const got = await fetchRecordingShareUrl(row.uuid);
      if (!got) {
        tally.gone++;
        if (goneDays.length < 5) goneDays.push(day);
      } else if (!got.shareUrl) {
        tally.noLink++;
      } else {
        // The same test the screens apply before showing a link: nothing is
        // stored that they would refuse to show.
        const url = zoomRecordingUrl(got.shareUrl);
        if (!url) {
          tally.notZoom++;
          console.log(`  ${day} Zoom returned a link that is not an https Zoom page — skipped`);
        } else {
          tally.ready++;
          hosts.add(new URL(url).hostname);
          if (got.passcodeProtected) tally.passcode++;
          if (APPLY) {
            await sql`
              UPDATE raw_inputs
              SET payload_json = jsonb_set(payload_json, '{meeting,share_url}', to_jsonb(${url}::text), true)
              WHERE id = ${row.raw_input_id}
                AND (payload_json -> 'meeting') IS NOT NULL
                AND (payload_json -> 'meeting' ->> 'share_url') IS NULL
            `;
            tally.written++;
          }
        }
      }
    } catch (e) {
      tally.errors++;
      console.log(`  ${day} ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(PAUSE_MS);
  }

  console.log(
    `\n  ${tally.ready} with a link` +
      (hosts.size ? ` (on ${[...hosts].sort().join(', ')})` : '') +
      `\n  ${tally.passcode} of those ask the viewer for a passcode (the passcode is not stored)` +
      `\n  ${tally.gone} not on Zoom any more` +
      (goneDays.length ? ` (e.g. ${goneDays.join(', ')})` : '') +
      `\n  ${tally.noLink} on Zoom but without a share link` +
      `\n  ${tally.notZoom} with a link that was refused` +
      `\n  ${tally.errors} errors`,
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
