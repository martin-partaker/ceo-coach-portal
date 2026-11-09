/**
 * Backfill `transcripts.cue_times` from the local Zoom VTT archive.
 *
 * Why this exists: `cleanVttTranscript` strips the VTT cue lines before the
 * transcript is persisted, so every stored transcript has the words and none
 * of the timing. Without timing there is no way to jump from a quote in the
 * audit to the moment in the call — which is the single thing the Director of
 * Coaching asked for.
 *
 * The archive (pulled from Zoom by `zoom_transcripts.py`) still has the cues,
 * and its `index.json` carries each meeting's UUID — the same key as
 * `raw_inputs.external_id`. So the join is exact, not heuristic.
 *
 * It is still verified. For every candidate the local file is cleaned with the
 * same rules the app uses and its SHA-256 compared against the stored
 * `content`. Only an exact match is written. A near-match is a different
 * recording, or the same recording processed differently, and either way the
 * cue offsets would not line up — so it is reported and skipped rather than
 * guessed at.
 *
 * Cue times are stored, not the raw VTT: the cleaned lines correspond 1:1 with
 * the cues, so a list of start-seconds carries all the timing at about a
 * fortieth of the size.
 *
 *   DATABASE_URL=<branch> pnpm tsx scripts/backfill-vtt-cues.ts [--archive DIR] [--apply]
 *
 * Without --apply it reports what it would do and writes nothing.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ARCHIVE = (() => {
  const i = args.indexOf('--archive');
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return path.join(process.env.HOME ?? '', 'Desktop/zoom-transcripts/transcripts');
})();

interface IndexEntry {
  uuid: string;
  file_type: string;
  path: string;
  start_time: string;
  topic: string;
}

/** Mirrors cleanVttTranscript in src/lib/zoom/client.ts, and additionally
 *  keeps the cue start time for each surviving line. */
function parseVtt(raw: string): { lines: string[]; cues: number[] } {
  const lines: string[] = [];
  const cues: number[] = [];
  let pending: number | null = null;

  for (const line of raw.split('\n')) {
    const s = line.trim();
    const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (m) {
      pending = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      continue;
    }
    if (line.startsWith('WEBVTT') || line.startsWith('NOTE')) continue;
    if (/^\d+$/.test(s)) continue;
    if (s === '') continue;
    lines.push(line.replace(/\r$/, ''));
    cues.push(pending ?? 0);
  }
  return { lines, cues };
}

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
/** The archive stores LF; Zoom delivers CRLF and that is what was persisted.
 *  Compare on a common footing rather than reporting a false mismatch. */
const normalise = (s: string) => s.replace(/\r\n/g, '\n');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL');

  const indexPath = path.join(ARCHIVE, 'index.json');
  if (!fs.existsSync(indexPath)) throw new Error(`no index.json under ${ARCHIVE}`);
  const index: IndexEntry[] = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  // Prefer the TRANSCRIPT rendering: it carries speaker labels. CC is the
  // closed-caption track and is a fallback only.
  const byUuid = new Map<string, string>();
  for (const kind of ['CC', 'TRANSCRIPT']) {
    for (const e of index) {
      if (e.file_type !== kind) continue;
      byUuid.set(e.uuid, path.join(ARCHIVE, e.path.replace(/^transcripts\//, '')));
    }
  }

  const sql = neon(process.env.DATABASE_URL);
  const rows = (await sql`
    SELECT t.id::text AS id, ri.external_id AS uuid, t.content,
           t.cue_times IS NOT NULL AS done
      FROM transcripts t
      JOIN raw_inputs ri ON ri.id = t.source_raw_input_id
     WHERE ri.external_id IS NOT NULL
  `) as { id: string; uuid: string; content: string; done: boolean }[];

  let matched = 0, already = 0, absent = 0, mismatch = 0;
  const writes: { id: string; cues: string; n: number; uuid: string }[] = [];

  for (const r of rows) {
    const file = byUuid.get(r.uuid);
    if (!file || !fs.existsSync(file)) { absent++; continue; }
    if (r.done) { already++; continue; }

    const { lines, cues } = parseVtt(fs.readFileSync(file, 'utf8'));
    const local = lines.join('\n').trim();
    if (sha(local) !== sha(normalise(r.content).trim())) {
      mismatch++;
      console.log(`  mismatch  ${r.uuid}  (${lines.length} local lines)`);
      continue;
    }
    matched++;
    writes.push({ id: r.id, cues: cues.join(','), n: cues.length, uuid: r.uuid });
  }

  console.log(
    `\n${rows.length} transcripts in the database\n` +
    `  ${absent} not in the archive\n` +
    `  ${already} already have cue times\n` +
    `  ${mismatch} found but the text does not match — skipped\n` +
    `  ${matched} verified and ready\n`
  );

  if (!APPLY) {
    console.log('Dry run. Re-run with --apply to write.');
    return;
  }

  for (const w of writes) {
    await sql`UPDATE transcripts SET cue_times = ${w.cues} WHERE id = ${w.id}::uuid`;
    console.log(`  wrote ${String(w.n).padStart(4)} cues  ${w.uuid}`);
  }
  console.log(`\n${writes.length} transcripts updated.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
