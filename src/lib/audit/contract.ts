/**
 * The contract between the Python evaluators and this app.
 *
 * "Implementing the review" is three things: producing the verdicts,
 * storing them, showing them. The producing already works and has a test
 * suite, so it stays in Python and runs offline; this file is the only
 * agreed shape between the two sides. Nothing here is a port.
 *
 * Two decisions in here are load-bearing, and both come from mistakes we
 * already made once.
 *
 * 1. A quote is a POINTER, never a copy. `Evidence.line` is the 0-based
 *    index of a line of `transcripts.content` split on "\n". Measured on
 *    the whole local archive — 220 files, 131,004 VTT cues — every cue has
 *    exactly one body line, and the Python parser's segment index equals
 *    the app's content line index in 220 of 220 files. So the UI can read
 *    the line itself. Consequences: a quote can never be truncated (the
 *    300-character cut is what sent Lauren back into the transcript, which
 *    is the thing the tool exists to avoid), and a stored copy can never
 *    drift from the source. The second of that line comes from
 *    `transcripts.cue_times` at the same index — which is why timestamps
 *    can be integrated later as a read-time join and not a migration.
 *
 * 2. Absence is stated, never implied. `notAssessed` and
 *    `familiesExamined` exist because a check that produces no finding
 *    when its input is missing reads exactly like a check that passed.
 *    That bug shipped once in Family D, and again in a measurement of mine
 *    keyed on a column that was NULL on 40 of 257 rows. A consumer of this
 *    contract must never render the empty case as a pass.
 */

export const AUDIT_CONTRACT_VERSION = 1;

/** `concern` = a real finding. `review` = needs a human. `ok` = assessed and clean. */
export type AuditVerdict = 'concern' | 'review' | 'ok';

/**
 * Where a criterion comes from. Shown next to every finding, because
 * Lauren rejected the first report partly for presenting our inferences
 * with the same authority as the outline's own words.
 *  - `source`     quoted from a ScaleOS document we hold
 *  - `documented` named independently by Lauren and/or Megan
 *  - `proposed`   ours, not yet confirmed by anyone
 */
export type AuditBasis = 'source' | 'documented' | 'proposed';

/**
 * How sure we are which session number this is. Never hidden: the whole
 * reason Lauren opens recordings by hand is that she cannot tell.
 *  - `confirmed`    first transcript, within 45 days of Intake, >=1 content marker
 *  - `probable`     within 45 days of Intake, no marker — the number is inferred
 *  - `undetermined` no Intake, or a gap beyond 45 days — no audit is run
 */
export type SessionConfidence = 'confirmed' | 'probable' | 'undetermined';

export type AuditFamily = 'A' | 'B' | 'C' | 'D' | 'conduct';

/** A pointer into `transcripts.content`. No text: see note 1 above. */
export interface AuditEvidence {
  /** 0-based index into `content.split('\n')`. */
  line: number;
  /** Inclusive last line of a quote that spans several lines. Omit for one line. */
  lineEnd?: number;
}

export interface AuditFinding {
  /** Criterion id, e.g. `prep.stated_constraint`. Stable across runs. */
  id: string;
  /** Outline step, e.g. `3.1c`. Null for criteria not tied to one step. */
  step: string | null;
  name: string;
  family: AuditFamily;
  verdict: AuditVerdict;
  detail: string;
  basis: AuditBasis;
  /** What the basis rests on, in words — the document and clause, or "ours". */
  restsOn: string;
  /** Null until Lauren supplies the weightings. The list does not sort by
   *  severity while this is null, rather than inventing an order. */
  severity: number | null;
  evidence: AuditEvidence[];
  /**
   * True when the criterion could not be assessed because its input was
   * absent — NOT when it was assessed and found clean. A renderer must say
   * "not assessed" for these and must never fold them into a pass.
   */
  notAssessed: boolean;
}

export interface AuditResult {
  contractVersion: typeof AUDIT_CONTRACT_VERSION;
  transcriptId: string;
  sessionNo: number | null;
  sessionConfidence: SessionConfidence;
  /** Why that confidence, in words, for the screen to show verbatim. */
  sessionConfidenceReason: string;
  /** Identifies the criteria set this run used, so a verdict can be traced. */
  criteriaVersion: string;
  /** ISO 8601. */
  generatedAt: string;
  coachLabel: string | null;
  totalSec: number | null;
  /**
   * SHA256 of `transcripts.content` as it was when this ran. Every line
   * index above is valid only for that exact text. If the stored content no
   * longer hashes to this, the audit is stale and the UI must refuse to
   * render it rather than point at lines that have moved.
   */
  contentSha256: string;
  /**
   * The families this run actually examined. A family listed here with no
   * findings was examined and is clean. A family NOT listed was never
   * examined, which is a different statement and must read differently.
   */
  familiesExamined: AuditFamily[];
  findings: AuditFinding[];
}

/**
 * Split `transcripts.content` into the lines an `AuditEvidence.line` indexes.
 *
 * Every consumer must go through this rather than calling `.split('\n')`
 * itself. All 257 stored transcripts are CRLF, so a bare split leaves a
 * trailing carriage return on every line, which renders as a stray character
 * or an unwanted break. The index is unaffected — the cue times were written
 * against this same split, and the alignment check counts these lines — so
 * this only decides what the quote looks like, and it should look the same
 * everywhere.
 */
export function transcriptLines(content: string): string[] {
  return content.split('\n').map((l) => l.replace(/\r$/, ''));
}

/**
 * Resolve one quote to its text and its second in the recording.
 *
 * `seconds` is `transcripts.cue_times` split on commas, or null where the
 * timing was never captured — 111 of 257 transcripts, so the null case is
 * ordinary and must render as a quote without a jump, not as an error.
 */
export function resolveEvidence(
  content: string,
  cueTimes: string | null,
  evidence: AuditEvidence,
): { text: string; startSec: number | null } | null {
  const lines = transcriptLines(content);
  const from = evidence.line;
  const to = evidence.lineEnd ?? evidence.line;
  if (from < 0 || from >= lines.length || to < from || to >= lines.length) {
    return null;
  }
  const secs = cueTimes ? cueTimes.split(',') : null;
  const raw = secs?.[from];
  const startSec = raw === undefined ? null : Number.parseInt(raw, 10);
  return {
    text: lines.slice(from, to + 1).join(' ').trim(),
    startSec: startSec === null || Number.isNaN(startSec) ? null : startSec,
  };
}

/** Narrow a parsed blob, so a contract drift fails loudly at the boundary. */
export function isAuditResult(v: unknown): v is AuditResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.contractVersion === AUDIT_CONTRACT_VERSION &&
    typeof o.transcriptId === 'string' &&
    typeof o.contentSha256 === 'string' &&
    Array.isArray(o.findings) &&
    Array.isArray(o.familiesExamined)
  );
}
