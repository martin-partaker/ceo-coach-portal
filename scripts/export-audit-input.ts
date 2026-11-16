/**
 * Dump every attributed recording, with the facts needed to say which session
 * it is, for the Python evaluators.
 *
 *   DATABASE_URL=<branch> pnpm tsx scripts/export-audit-input.ts --out recordings.json
 *
 * Read-only. Writes one JSON file. `tool/place_sessions.py` turns it into the
 * list of sessions to audit; `tool/make_audit_json.py` audits them.
 * `scripts/regenerate-audits.sh` runs the whole chain.
 *
 * This script used to decide the session itself (Session 1 only) and export
 * just those. It now exports facts and decides nothing: placing the later
 * sessions is a rule over each CEO's whole run of recordings, and that rule
 * lives where it can be measured and tested against the recordings, in
 * `place_sessions.py` — together with the Session 1 rule, moved there
 * unchanged, so there is one place that says what a session is.
 *
 * What is NOT obvious in here, and was measured rather than assumed:
 *
 * ATTRIBUTION goes through `raw_input_ceos`, never
 * `transcripts.authored_by_ceo_id`. That column is NULL on 40 of 257 rows and
 * disagrees with the raw input on 41, because a group call has several CEOs
 * and one column cannot hold them. Keying on it moved 17 CEOs' "first
 * transcript" months later than the truth. See `attribuzione-ceo-transcript.md`.
 * A recording coached with two partners appears once, with both CEOs and each
 * one's own position in their own run.
 *
 * A REVIEWER'S WORD on the session (`transcript_session_overrides`) is
 * exported as it was given — who, when, the note — so the reason shown on the
 * audit can say a person said so, and never that we inferred it.
 *
 * The file holds full transcripts and the CEOs' own submissions. It stays on
 * the machine it was written on.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { buildPrepRecord } from '../src/lib/audit/tally-fields';

const args = process.argv.slice(2);
const outPath = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'recordings.json';
})();

type Row = {
  transcript_id: string;
  ceo_id: string;
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
  intake_payload: unknown;
  worksheet_payload: unknown;
};

type OverrideRow = {
  transcript_id: string;
  session_no: number | null;
  note: string | null;
  set_at: string;
  set_by: string;
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
    ),
    latest_intake AS (
      SELECT DISTINCT ON (ceo_id) ceo_id, payload_json FROM raw_inputs
      WHERE content_type = 'intake' AND ceo_id IS NOT NULL
      ORDER BY ceo_id, occurred_at DESC
    ),
    latest_worksheet AS (
      SELECT DISTINCT ON (ceo_id) ceo_id, payload_json FROM raw_inputs
      WHERE content_type = 'goal_worksheet' AND ceo_id IS NOT NULL
      ORDER BY ceo_id, occurred_at DESC
    )
    SELECT k.transcript_id, k.ceo_id, k.title, k.recorded_at, k.duration, k.meeting_type,
           k.content, k.cue_times, c.name AS ceo_name, co.name AS coach_name,
           k.seq::int AS seq, k.gap_days::float AS gap_days, i.intake_at,
           li.payload_json AS intake_payload, lw.payload_json AS worksheet_payload
    FROM ranked k
    LEFT JOIN ceos c     ON c.id = k.ceo_id
    LEFT JOIN coaches co ON co.id = c.coach_id
    LEFT JOIN intake i   ON i.ceo_id = k.ceo_id
    LEFT JOIN latest_intake    li ON li.ceo_id = k.ceo_id
    LEFT JOIN latest_worksheet lw ON lw.ceo_id = k.ceo_id
    ORDER BY c.name NULLS LAST, k.recorded_at
  `) as unknown as Row[];

  // What reviewers have said. The table exists only where the audit screens
  // have been deployed, so its absence is "nobody could have said anything",
  // not an error.
  const [{ present }] = (await sql`
    SELECT to_regclass('public.transcript_session_overrides') IS NOT NULL AS present
  `) as unknown as { present: boolean }[];
  const overrideRows = present
    ? ((await sql`
        SELECT o.transcript_id, o.session_no, o.note, o.set_at, c.name AS set_by
        FROM transcript_session_overrides o
        JOIN coaches c ON c.id = o.set_by
      `) as unknown as OverrideRow[])
    : [];
  const overrides = new Map(overrideRows.map((o) => [o.transcript_id, o]));

  type Out = {
    transcriptId: string;
    title: string;
    recordedAt: string;
    durationMin: number | null;
    meetingType: string | null;
    coachName: string | null;
    /**
     * One entry per CEO on the recording: their own count, their own gap,
     * their own Intake. `daysAfterIntake` is not rounded: the Session 1 rule
     * compares it with a window, and 45.4 days is outside a 45-day one.
     * `prep` is the CEO's pre-work for Session 1, on their first recording only.
     */
    ceos: {
      name: string | null;
      seq: number;
      gapDays: number | null;
      daysAfterIntake: number | null;
      prep?: ReturnType<typeof buildPrepRecord>;
    }[];
    /** A reviewer's word on the session, when there is one. */
    override?: { sessionNo: number | null; by: string; at: string; note: string | null };
    content: string;
    cueTimes: string | null;
  };

  const byId = new Map<string, Out>();
  for (const r of rows) {
    const ov = overrides.get(r.transcript_id);
    const rec: Out = byId.get(r.transcript_id) ?? {
      transcriptId: r.transcript_id,
      title: r.title,
      recordedAt: new Date(r.recorded_at).toISOString(),
      durationMin: r.duration,
      meetingType: r.meeting_type,
      coachName: r.coach_name,
      ceos: [],
      ...(ov
        ? {
            override: {
              sessionNo: ov.session_no,
              by: ov.set_by,
              at: new Date(ov.set_at).toISOString(),
              note: ov.note,
            },
          }
        : {}),
      content: r.content,
      cueTimes: r.cue_times,
    };
    rec.ceos.push({
      name: r.ceo_name,
      seq: r.seq,
      gapDays: r.gap_days,
      daysAfterIntake:
        r.intake_at === null
          ? null
          : (new Date(r.recorded_at).getTime() - new Date(r.intake_at).getTime()) / 86_400_000,
      ...(r.seq === 1 ? { prep: buildPrepRecord(r.intake_payload, r.worksheet_payload) } : {}),
    });
    byId.set(r.transcript_id, rec);
  }
  const out = [...byId.values()];
  writeFileSync(outPath, JSON.stringify(out, null, 1));

  const firsts = out.filter((o) => o.ceos.some((c) => c.seq === 1));
  const prep = firsts.map((o) => o.ceos.find((c) => c.seq === 1 && c.prep)?.prep ?? null);
  const exported = new Set(out.map((o) => o.transcriptId));
  console.log(
    `${out.length} recordings of ${new Set(rows.map((r) => r.ceo_id)).size} CEOs -> ${outPath}`,
  );
  console.log(`  ${out.filter((o) => o.cueTimes).length} have cue times`);
  console.log(
    `  session set by a reviewer: ${out.filter((o) => o.override).length}` +
      (present ? '' : ' (no overrides table in this database)') +
      (overrideRows.some((o) => !exported.has(o.transcript_id))
        ? ` · ${overrideRows.filter((o) => !exported.has(o.transcript_id)).length} more on recordings with no attributed CEO`
        : ''),
  );
  console.log(
    `  first recordings: ${firsts.length}; with a prep record: ${prep.filter(Boolean).length} ` +
      `(constraint ${prep.filter((p) => p?.stated_constraint).length}, ` +
      `guardrails ${prep.filter((p) => p?.guardrails).length}, ` +
      `figures ${prep.filter((p) => p?.figures).length})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
