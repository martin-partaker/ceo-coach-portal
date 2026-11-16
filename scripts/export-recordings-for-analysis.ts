/**
 * Dump EVERY attributed recording, with where it falls in each CEO's run of
 * recordings, for working out how to place sessions after the first.
 *
 *   ( set -a; . ./.env.staging; set +a; pnpm tsx scripts/export-recordings-for-analysis.ts --out ~/Desktop/zoom-transcripts/recordings_all.json )
 *
 * Read-only. It is NOT part of generating audits: `export-audit-input.ts`
 * still exports only what is audited. This exists because the rule for
 * "which recording is the Session 2" has to be measured on all of them before
 * it is written — the Session 1 thresholds were measured the same way.
 *
 * The file holds full transcripts. It stays on this machine.
 *
 * Attribution goes through `raw_input_ceos`, as in export-audit-input.ts and
 * for the same reason. A recording coached with two partners appears once,
 * with both CEOs and each one's own position in their own run.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const args = process.argv.slice(2);
const outPath = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'recordings_all.json';
})();

type Row = {
  transcript_id: string;
  title: string;
  recorded_at: string;
  duration: number | null;
  meeting_type: string | null;
  content: string;
  cue_times: string | null;
  ceo_name: string | null;
  coach_name: string | null;
  seq: number;
  gap_days: number | null;
  intake_at: string | null;
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL');
  const sql = neon(process.env.DATABASE_URL);

  const rows = (await sql`
    WITH attrib AS (
      SELECT DISTINCT t.id AS transcript_id, ric.ceo_id, t.title, t.recorded_at,
             t.duration, r.classification ->> 'meetingType' AS meeting_type,
             t.content, t.cue_times
      FROM transcripts t
      JOIN raw_inputs r       ON r.id = t.source_raw_input_id
      JOIN raw_input_ceos ric ON ric.raw_input_id = r.id
    ),
    ranked AS (
      SELECT *,
             row_number() OVER (PARTITION BY ceo_id ORDER BY recorded_at) AS seq,
             extract(epoch FROM recorded_at - lag(recorded_at)
               OVER (PARTITION BY ceo_id ORDER BY recorded_at)) / 86400 AS gap_days
      FROM attrib
    ),
    intake AS (
      SELECT ceo_id, min(occurred_at) AS intake_at
      FROM raw_inputs WHERE content_type = 'intake' AND ceo_id IS NOT NULL
      GROUP BY ceo_id
    )
    SELECT k.transcript_id, k.title, k.recorded_at, k.duration, k.meeting_type,
           k.content, k.cue_times, c.name AS ceo_name, co.name AS coach_name,
           k.seq::int AS seq, k.gap_days::float AS gap_days, i.intake_at
    FROM ranked k
    LEFT JOIN ceos c     ON c.id = k.ceo_id
    LEFT JOIN coaches co ON co.id = c.coach_id
    LEFT JOIN intake i   ON i.ceo_id = k.ceo_id
    ORDER BY c.name NULLS LAST, k.recorded_at
  `) as unknown as Row[];

  const [{ present }] = (await sql`
    SELECT to_regclass('public.transcript_session_overrides') IS NOT NULL AS present
  `) as unknown as { present: boolean }[];
  const overrides = new Map(
    (present
      ? ((await sql`
          SELECT transcript_id, session_no FROM transcript_session_overrides
        `) as unknown as { transcript_id: string; session_no: number | null }[])
      : []
    ).map((o) => [o.transcript_id, o.session_no]),
  );

  type Out = {
    transcriptId: string;
    title: string;
    recordedAt: string;
    durationMin: number | null;
    meetingType: string | null;
    coachName: string | null;
    /** One entry per CEO on the recording: their own count and their own gap. */
    ceos: { name: string | null; seq: number; gapDays: number | null; daysAfterIntake: number | null }[];
    /** A reviewer's word, when there is one: a number, or null for "not a numbered session". */
    sessionSetByReviewer?: number | null;
    content: string;
    cueTimes: string | null;
  };
  const byId = new Map<string, Out>();
  for (const r of rows) {
    const rec =
      byId.get(r.transcript_id) ??
      ({
        transcriptId: r.transcript_id,
        title: r.title,
        recordedAt: new Date(r.recorded_at).toISOString(),
        durationMin: r.duration,
        meetingType: r.meeting_type,
        coachName: r.coach_name,
        ceos: [],
        ...(overrides.has(r.transcript_id)
          ? { sessionSetByReviewer: overrides.get(r.transcript_id) ?? null }
          : {}),
        content: r.content,
        cueTimes: r.cue_times,
      } satisfies Out);
    rec.ceos.push({
      name: r.ceo_name,
      seq: r.seq,
      gapDays: r.gap_days === null ? null : Math.round(r.gap_days),
      daysAfterIntake:
        r.intake_at === null
          ? null
          : Math.round(
              (new Date(r.recorded_at).getTime() - new Date(r.intake_at).getTime()) / 86_400_000,
            ),
    });
    byId.set(r.transcript_id, rec);
  }
  const out = [...byId.values()];
  writeFileSync(outPath, JSON.stringify(out, null, 1));

  const bySeq = new Map<number, number>();
  for (const o of out) {
    const s = Math.min(...o.ceos.map((c) => c.seq));
    bySeq.set(s, (bySeq.get(s) ?? 0) + 1);
  }
  console.log(`${out.length} recordings of ${new Set(rows.map((r) => r.ceo_name)).size} CEOs -> ${outPath}`);
  console.log(
    `  by position in the CEO's run: ${[...bySeq.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([s, n]) => `#${s} ${n}`)
      .join(' · ')}`,
  );
  console.log(`  ${out.filter((o) => o.cueTimes).length} have cue times`);
  console.log(`  ${out.filter((o) => 'sessionSetByReviewer' in o).length} have a session set by a reviewer`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
