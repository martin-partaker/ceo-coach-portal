import type { DraftedReport } from './schemas';

/**
 * Throw a clear, actionable error if the Anthropic API returned with
 * `stop_reason === 'max_tokens'`. Without this guard the truncated
 * output reaches the JSON parser (or zod) and surfaces as a cryptic
 * "Unterminated string" / schema-validation error that is hard to
 * connect back to the actual cause.
 */
export function assertNotTruncated(
  message: { stop_reason?: string | null },
  stage: string,
  maxTokens: number,
): void {
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      `${stage}: model output truncated at max_tokens=${maxTokens}. ` +
        `The reply is incomplete — try regenerating, or raise the cap for this stage.`,
    );
  }
}

/**
 * Replace em-dashes (U+2014) with commas across all prose fields of a
 * DraftedReport. Claude leans hard on em-dashes stylistically; the
 * coach + CEO read cleaner output without them. Comma is the most
 * grammatically neutral replacement for the parenthetical-clause use
 * that em-dashes get in this report ("X — Y" → "X, Y").
 *
 * We strip *after* zod validation so the schema check sees the model's
 * raw output (catches genuine schema drift) but downstream consumers
 * see clean prose.
 *
 * Resource ids are left alone — they're uuids, not prose.
 */
export function stripEmDashesFromDraft(d: DraftedReport): DraftedReport {
  return {
    subject_line: stripEm(d.subject_line),
    opening: stripEm(d.opening),
    wins_and_progress: stripEm(d.wins_and_progress),
    honest_feedback: stripEm(d.honest_feedback),
    key_insight: stripEm(d.key_insight),
    commitments: stripEm(d.commitments),
    going_deeper: stripEm(d.going_deeper),
    closing: stripEm(d.closing),
    report: {
      progressSummary: stripEm(d.report.progressSummary),
      goalSummary: d.report.goalSummary
        ? {
            tenX: stripEm(d.report.goalSummary.tenX),
            ninetyDay: d.report.goalSummary.ninetyDay
              ? stripEm(d.report.goalSummary.ninetyDay)
              : null,
            thirtyDay: d.report.goalSummary.thirtyDay
              ? stripEm(d.report.goalSummary.thirtyDay)
              : null,
            flag: d.report.goalSummary.flag
              ? stripEm(d.report.goalSummary.flag)
              : null,
          }
        : null,
      keyWins: d.report.keyWins.map(stripEm),
      challenges: d.report.challenges.map(stripEm),
      patternObservations: stripEm(d.report.patternObservations),
      suggestedNextSteps: d.report.suggestedNextSteps.map(stripEm),
      suggestedResourceIds: d.report.suggestedResourceIds,
      coachReviewFlags: d.report.coachReviewFlags.map((f) => ({
        ...f,
        title: stripEm(f.title),
        detail: stripEm(f.detail),
      })),
    },
  };
}

/**
 * Replace em-dash (U+2014) with comma+space, collapsing surrounding
 * whitespace. Idempotent.
 */
export function stripEm(s: string): string {
  return s
    .replace(/\s*—\s*/g, ', ')
    // Cleanup: ", , " can occur if input already had a comma right
    // before the em-dash; collapse to a single comma.
    .replace(/,\s*,/g, ',')
    // Whitespace before comma can sneak in via the replacement.
    .replace(/\s+,/g, ',');
}
