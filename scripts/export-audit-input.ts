/**
 * Dump the Session 1 audit candidates for the Python evaluators.
 *
 *   DATABASE_URL=<branch> pnpm tsx scripts/export-audit-input.ts --out candidates.json
 *
 * Read-only. Writes one JSON file; `tool/make_audit_json.py` consumes it.
 *
 * Two things in here are not obvious and both were measured, not assumed.
 *
 * 1. ATTRIBUTION goes through `raw_input_ceos`, never
 *    `transcripts.authored_by_ceo_id`. That column is NULL on 40 of 257 rows
 *    and disagrees with the raw input on 41, because a group call has several
 *    CEOs and one column cannot hold them. Keying on it moved 17 CEOs' "first
 *    transcript" months later than the truth. See
 *    `attribuzione-ceo-transcript.md`.
 *
 * 2. The SESSION 1 CONFIDENCE tiers are a classifier that declares its own
 *    uncertainty, not a guess dressed as a fact. Thresholds below.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { buildPrepRecord } from '../src/lib/audit/tally-fields';

const args = process.argv.slice(2);
const outPath = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'candidates.json';
})();

/**
 * Content markers almost unique to a Session 1, from the outline: materials
 * delivered 48 hours ahead, the Flight System overview, the two 30-minute
 * support calls, the first-and-third-Thursday group training.
 *
 * The >= 3 threshold is not inherited, it is measured: at >= 3 these patterns
 * match 8 of the 44 first transcripts and 0 of the other 216. At >= 2 they
 * match 18 but leak into 2 of the 216, and at >= 1 they leak into 43, which is
 * no discriminator at all. An earlier run of this measurement reported 11 with
 * markers, but those patterns were never written down anywhere and cannot be
 * recovered; these are defined here so the number is reproducible from now on.
 * They were NOT tuned to reproduce 11 — that would be fitting to a figure
 * whose provenance is lost.
 */
const MARKERS = [
  String.raw`(48|forty.?eight)\s*(hours?|hrs?)`,
  String.raw`flight\s*(system|plan)`,
  String.raw`(30|thirty)[\s-]*(minute|min)[\s-]*(support|call)|two\s+(30|thirty)`,
  String.raw`(first|1st)\s+and\s+(third|3rd)\s+thursday|group\s+(training|coaching)\s+(call|session)`,
];
const MARKER_THRESHOLD = 3;
/** A Session 1 follows the Intake closely. Beyond this, the first captured
 *  call is almost never the Session 1 — it was never recorded. */
const INTAKE_WINDOW_DAYS = 45;

type Row = {
  transcript_id: string;
  ceo_id: string;
  ceo_name: string | null;
  coach_name: string | null;
  content: string;
  cue_times: string | null;
  recorded_at: string;
  intake_at: string | null;
  n_marker: number;
  intake_payload: unknown;
  worksheet_payload: unknown;
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL');
  const sql = neon(process.env.DATABASE_URL);

  const markerSum = MARKERS.map((p) => `(t.content ~* '${p}')::int`).join(' + ');

  // sql.query() rather than the template tag: the marker expression is built
  // from the MARKERS constant above. Those patterns are literals in this
  // file, never user input, so there is nothing to parameterise.
  const rows = (await sql.query(`
    WITH attrib AS (
      SELECT DISTINCT t.id AS transcript_id, ric.ceo_id, t.content, t.cue_times,
             t.recorded_at, ${markerSum} AS n_marker
      FROM transcripts t
      JOIN raw_inputs r       ON r.id = t.source_raw_input_id
      JOIN raw_input_ceos ric ON ric.raw_input_id = r.id
    ),
    firsts AS (
      SELECT DISTINCT ON (ceo_id) * FROM attrib ORDER BY ceo_id, recorded_at ASC
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
    SELECT f.transcript_id, f.ceo_id, c.name AS ceo_name, co.name AS coach_name,
           f.content, f.cue_times, f.recorded_at, i.intake_at, f.n_marker,
           li.payload_json AS intake_payload,
           lw.payload_json AS worksheet_payload
    FROM firsts f
    LEFT JOIN ceos   c  ON c.id = f.ceo_id
    LEFT JOIN coaches co ON co.id = c.coach_id
    LEFT JOIN intake i  USING (ceo_id)
    LEFT JOIN latest_intake    li ON li.ceo_id = f.ceo_id
    LEFT JOIN latest_worksheet lw ON lw.ceo_id = f.ceo_id
    ORDER BY c.name NULLS LAST
  `)) as unknown as Row[];

  const perCeo = rows.map((r) => {
    const gapDays =
      r.intake_at === null
        ? null
        : (new Date(r.recorded_at).getTime() - new Date(r.intake_at).getTime()) /
          86_400_000;

    let confidence: 'confirmed' | 'probable' | 'undetermined';
    let reason: string;
    if (gapDays === null) {
      confidence = 'undetermined';
      reason =
        'This CEO filed no Intake, so there is no date to anchor a Session 1 to. ' +
        'No session number is claimed and no audit was run.';
    } else if (gapDays > INTAKE_WINDOW_DAYS) {
      confidence = 'undetermined';
      reason =
        `Their first captured call is ${Math.round(gapDays)} days after their Intake, ` +
        `beyond the ${INTAKE_WINDOW_DAYS}-day window. Their Session 1 was most likely ` +
        'never recorded, so this call is probably a later session. No session number ' +
        'is claimed and no audit was run.';
    } else if (r.n_marker >= MARKER_THRESHOLD) {
      confidence = 'confirmed';
      reason =
        `Their first captured call, ${Math.round(gapDays)} days after their Intake, ` +
        `carrying ${r.n_marker} of 4 content markers specific to a Session 1. ` +
        'These markers appear in none of the other 216 transcripts.';
    } else {
      confidence = 'probable';
      reason =
        `Their first captured call, ${Math.round(gapDays)} days after their Intake, ` +
        `but with only ${r.n_marker} of 4 Session 1 content markers. The session ` +
        'number is inferred from the dates, not evidenced in what was said — worth ' +
        'confirming before relying on the verdicts.';
    }

    return {
      transcriptId: r.transcript_id,
      ceoName: r.ceo_name,
      coachName: r.coach_name,
      clientName: r.ceo_name,
      content: r.content,
      cueTimes: r.cue_times,
      sessionNo: confidence === 'undetermined' ? null : 1,
      sessionConfidence: confidence,
      sessionConfidenceReason: reason,
      prep: buildPrepRecord(r.intake_payload, r.worksheet_payload),
    };
  });

  /**
   * One candidate per RECORDING, not per CEO.
   *
   * The query above yields each CEO's first transcript, and two CEOs who are
   * coached together share one. Emitting both made two audits of the same
   * recording in a single run — one "confirmed" for the CEO who filed the
   * Intake, one "undetermined" for the partner who did not — and which of the
   * two the list then showed came down to insertion order. A session is what
   * it is for everyone in it, so the best-placed CEO decides, and every CEO on
   * the recording is named.
   */
  const RANK = { confirmed: 0, probable: 1, undetermined: 2 } as const;
  const byTranscript = new Map<string, (typeof perCeo)[number][]>();
  for (const c of perCeo) {
    const group = byTranscript.get(c.transcriptId) ?? [];
    group.push(c);
    byTranscript.set(c.transcriptId, group);
  }
  const out = [...byTranscript.values()].map((group) => {
    const best = [...group].sort(
      (a, b) => RANK[a.sessionConfidence] - RANK[b.sessionConfidence],
    )[0];
    const names = [...new Set(group.map((g) => g.ceoName).filter(Boolean))];
    return {
      ...best,
      ceoName: names.join(' & ') || null,
      prep: best.prep ?? group.find((g) => g.prep !== null)?.prep ?? null,
    };
  });

  writeFileSync(outPath, JSON.stringify(out, null, 1));

  const by = (c: string) => out.filter((o) => o.sessionConfidence === c).length;
  const withPrep = out.filter((o) => o.prep !== null).length;
  const withConstraint = out.filter((o) => o.prep?.stated_constraint).length;
  const withRails = out.filter((o) => o.prep?.guardrails).length;
  const withFigures = out.filter((o) => o.prep?.figures).length;

  console.log(`${out.length} recordings (first transcript of ${perCeo.length} CEOs) -> ${outPath}`);
  console.log(
    `  confirmed ${by('confirmed')} · probable ${by('probable')} · ` +
      `undetermined ${by('undetermined')}`,
  );
  console.log(`  ${out.filter((o) => o.cueTimes).length} have cue times`);
  console.log(
    `  prep record: ${withPrep} (constraint ${withConstraint}, ` +
      `guardrails ${withRails}, figures ${withFigures})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
