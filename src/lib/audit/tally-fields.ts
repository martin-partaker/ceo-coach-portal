/**
 * Tally question ids -> the three prep fields Family D tests.
 *
 * This map has to exist because a Tally submission payload carries no question
 * labels — only opaque ids like `VZ4MWM` and `elZWzMl`. The app never needed
 * the mapping: `projectIntake` copies the whole blob into `ceos.profileJson`
 * and hands it to the prompt. The audit does need it, because Family D asks
 * whether the session engaged three specific things the CEO filed beforehand.
 *
 * The ids come from `tally_forms.questions_snapshot`, which does hold the
 * labels. Counts below are CEOs with a non-empty answer, measured on the
 * production copy on 2026-11-09 — they are the ceiling on what Family D can
 * ever assess, so they belong next to the ids.
 */

/** 10x Goal Worksheet, form ODAl8a. */
const WORKSHEET = {
  /**
   * "What's my current biggest constraint toward achieving this goal?" — 37 CEOs.
   *
   * This is the primary source for D3, and it matters which one is primary.
   * Megan corrected D3 from "biggest revenue constraint" to the biggest
   * constraint on reaching the 10x goal; this question asks precisely that, in
   * those words. An earlier note of mine said the criterion had outrun its
   * instrument — wrong, and it came from looking only at the Intake.
   */
  constraintTowardGoal: 'OAjMD8',
  /** "Guardrails:" appears three times, once per goal option — 37 / 20 / 16 CEOs. */
  guardrails: ['g5Q6Dd', '0EbRQ6', 'YZol5d'],
} as const;

/** Intake Survey, form RGzkkp. */
const INTAKE = {
  /**
   * "From your perspective, what's your current biggest revenue constraint?"
   * — 41 CEOs. Secondary for D3: wider coverage than the worksheet question
   * but narrower in meaning, so it is the fallback, never the preference.
   */
  revenueConstraint: 'VZ4MWM',
  /** The figures D4 asks whether the session picked up. */
  figures: [
    ['revenue', '0EDJqB'],
    ['EBITDA', 'zK1r8M'],
    ['top-3 customer concentration', 'RzVJq4'],
    ['recurring vs one-time', 'oAk78O'],
  ],
} as const;

type TallyResponse = { questionId?: string; answer?: unknown };

/** Tally answers are strings, numbers, string arrays, or arrays of file objects. */
function answerText(answer: unknown): string {
  if (answer === null || answer === undefined) return '';
  if (typeof answer === 'string') return answer.trim();
  if (typeof answer === 'number' || typeof answer === 'boolean') return String(answer);
  if (Array.isArray(answer)) {
    return answer
      .map((a) => (typeof a === 'string' || typeof a === 'number' ? String(a) : ''))
      .filter(Boolean)
      .join(', ')
      .trim();
  }
  return '';
}

function index(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const responses = (payload as { responses?: TallyResponse[] } | null)?.responses;
  if (!Array.isArray(responses)) return out;
  for (const r of responses) {
    const qid = r?.questionId;
    if (typeof qid !== 'string') continue;
    const text = answerText(r.answer);
    if (text) out.set(qid, text);
  }
  return out;
}

/** What the evaluators' `prep_fields` reads. Absent keys mean "nothing filed". */
export interface PrepRecord {
  stated_constraint?: string;
  guardrails?: string;
  figures?: string;
}

/**
 * Build the prep record for one CEO from their two submissions.
 *
 * Keys are emitted at the top level on purpose. `prep_fields` walks
 * (root, intake, worksheet) and keeps the first value it finds per field, so
 * nesting would silently hand D3 to whichever scope came first. Precedence is
 * decided here instead, where it is visible: the worksheet's question wins
 * because it is the one that matches the criterion.
 *
 * A field is omitted rather than set to an empty string. The distinction is
 * load-bearing downstream: an omitted field means the CEO filed nothing, which
 * Family D reports as "nothing to pick up — not a finding about the coach",
 * while no record at all means the criterion was never assessed. Collapsing
 * those two is the bug that made Family D silently skip.
 */
export function buildPrepRecord(
  intakePayload: unknown,
  worksheetPayload: unknown,
): PrepRecord | null {
  const intake = index(intakePayload);
  const worksheet = index(worksheetPayload);
  if (intake.size === 0 && worksheet.size === 0) return null;

  const out: PrepRecord = {};

  const constraint =
    worksheet.get(WORKSHEET.constraintTowardGoal) ??
    intake.get(INTAKE.revenueConstraint);
  if (constraint) out.stated_constraint = constraint;

  const rails = WORKSHEET.guardrails
    .map((qid) => worksheet.get(qid))
    .filter((v): v is string => Boolean(v));
  if (rails.length) out.guardrails = rails.join(' | ');

  const figures = INTAKE.figures
    .map(([label, qid]) => {
      const v = intake.get(qid);
      return v ? `${label}: ${v}` : null;
    })
    .filter((v): v is string => Boolean(v));
  if (figures.length) out.figures = figures.join(' | ');

  return out;
}
