import type { DraftedReport, CycleFacts } from './schemas';

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
export function stripEmDashesFromDraft(
  d: DraftedReport,
  facts?: CycleFacts,
): DraftedReport {
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
      progressSummary: fixMetricsHeader(stripEm(d.report.progressSummary)),
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
              ? stripFlagPrefix(stripEm(d.report.goalSummary.flag))
              : null,
          }
        : null,
      keyWins: d.report.keyWins.map(stripEm),
      challenges: d.report.challenges.map(stripEm),
      patternObservations: stripEm(d.report.patternObservations),
      suggestedNextSteps: d.report.suggestedNextSteps.map((s) =>
        moveAltitudeTagPeriod(stripEm(s)),
      ),
      suggestedResourceIds: d.report.suggestedResourceIds,
      coachReviewFlags: d.report.coachReviewFlags.map((f) => ({
        ...f,
        title: stripEm(f.title),
        detail: stripEm(f.detail),
      })),
      closing: synthesiseClosing(d, facts),
    },
  };
}

/**
 * Belt-and-braces fallback for the `report.closing` block. The drafter
 * prompt requires the model to populate it, but Haiku-class models
 * sometimes drop nullable fields. When that happens the PDF ends
 * abruptly at the last Next Step bullet — looks unfinished and skips
 * the "Next session: <date>" sign-off the coach expects.
 *
 * Strategy:
 *   1. If the model returned a non-empty `report.closing.sentence`,
 *      use it verbatim (with em-dashes stripped).
 *   2. Otherwise, mine the email's `closing` field for a usable sentence.
 *      The email closing typically ends with the coach's sign-off
 *      ("Talk soon, Eric") — we extract the lead sentence(s) before
 *      that and drop the sign-off itself.
 *   3. If both are empty, return null and the PDF skips the block.
 */
function synthesiseClosing(
  d: DraftedReport,
  facts?: CycleFacts,
): DraftedReport['report']['closing'] {
  // Prefer facts.nextSessionDate as the source-of-truth for the
  // "Next session: X" line. When the model populates closing it
  // usually copies this value verbatim, but the fallback path below
  // needs to inject it explicitly.
  const factsNextSession = facts?.nextSessionDate?.trim() || null;
  const existing = d.report.closing;
  if (existing && existing.sentence.trim()) {
    return {
      sentence: stripEm(existing.sentence),
      // Re-honor facts.nextSessionDate if the model left it null but
      // the date is actually known from extraction. Conservative: only
      // fill in when the model didn't already commit to a value.
      nextSessionDate: existing.nextSessionDate ?? factsNextSession,
    };
  }
  const emailClosing = d.closing?.trim() ?? '';
  if (!emailClosing) return null;
  // Strip the sign-off line ("Talk soon, Eric", "Eric", "— Eric") — the
  // sign-off belongs to the email view; the structured closing block is
  // the encouraging *body* tail, not the salutation. We treat the last
  // line as the salutation if it's short (≤4 words) AND comes after a
  // double newline or comma — that catches "Talk soon, Eric" / "Eric"
  // patterns without scissoring real sentences.
  const lines = emailClosing.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let body = lines.join(' ');
  const lastLine = lines[lines.length - 1] ?? '';
  if (lastLine && lastLine.split(/\s+/).length <= 4 && lines.length > 1) {
    body = lines.slice(0, -1).join(' ');
  }
  // Also strip "Talk soon, X" / "Best, X" / "Onwards, X" patterns at the
  // end of the body itself (in case the model put everything on one line).
  body = body.replace(/\s*(talk soon|best|onwards|cheers|warmly|onward|in your corner)[,.]?\s+\S+\.?\s*$/i, '');
  body = body.trim();
  if (!body) return null;
  return {
    sentence: stripEm(body),
    nextSessionDate: factsNextSession,
  };
}

/**
 * Strip a leading "Flag for Coach Review:" prefix (with optional smart
 * quotes / markdown bold wrappers around it) from a goalSummary.flag
 * value. The PDF renderer already prepends "⚑ Flag for Coach Review: "
 * to the field; when the model also includes that text in the value
 * itself, the rendered output reads "⚑ Flag for Coach Review: 'Flag
 * for Coach Review: ...'" — duplicated and odd-looking.
 *
 * The model intermittently emits this prefix because it matches the
 * pattern shown in the fewshot exemplar (which uses a blockquote
 * with the prefix as part of the rendered markdown). We tell the model
 * not to include it in the JSON, but belt-and-braces strip here so the
 * output is clean regardless.
 */
function stripFlagPrefix(s: string): string {
  // Tolerate: optional smart/straight leading quote, optional **bold**
  // wrapping, the literal phrase, optional trailing colon, optional
  // trailing closing quote, then arbitrary whitespace before the
  // actual content begins.
  return s
    .replace(
      /^\s*['"‘’“”]?\s*(?:\*\*)?\s*Flag for Coach Review\s*:?\s*(?:\*\*)?\s*['"‘’“”]?\s*/i,
      '',
    )
    .trim();
}

/**
 * Rename the Momentum Check metrics sub-heading to "Metrics and what
 * moved" (client request). The drafter emits "**Metrics — what moved:**"
 * which `stripEm` turns into "**Metrics, what moved:**"; either form (and
 * a plain hyphen variant) is normalised here so the rendered header reads
 * "Metrics and what moved:". Idempotent.
 */
export function fixMetricsHeader(s: string): string {
  return s.replace(
    /\*\*\s*Metrics\s*(?:,|—|–|-|and)?\s*what moved\s*:?\s*\*\*/gi,
    '**Metrics and what moved:**',
  );
}

/**
 * Move the sentence-ending period from the end of a Next Step's bold
 * lead-in to *after* the italic Altitude Matrix tag (client request):
 *
 *   before: **Re-engage the BD search this week.** *(Eliminate / Leadership)* Repair…
 *   after:  **Re-engage the BD search this week** *(Eliminate / Leadership)*. Repair…
 *
 * Only the first "…**.** *(tag)*" pattern per string is rewritten (the
 * lead-in). Steps that don't match (no tag, or already in the new shape)
 * are returned unchanged, so this is safe to run on any output.
 * Idempotent.
 */
export function moveAltitudeTagPeriod(s: string): string {
  return s.replace(
    /\.\*\*(\s*)(\*\([^)]*\)\*)/,
    '**$1$2.',
  );
}

/**
 * Replace em-dash (U+2014) with comma+space and substitute Unicode
 * characters that react-pdf's built-in Helvetica font can't render
 * (the PDF would otherwise show "e" or an apostrophe in their place).
 *
 * Substitution rationale:
 *   - Em-dashes ("—") are stylistically heavy and the coach voice
 *     reads cleaner with commas in their place.
 *   - Arrows (→, ←, ⇒, ⇐) get replaced with "to" / "from" / ">" / "<"
 *     because Helvetica drops them to an apostrophe glyph. Affects
 *     things like "Q1→Q2" and "494 → 400 → 86 min" which the model
 *     produces naturally.
 *   - Math comparators (≥, ≤, ≠, ±) get ASCII fallbacks for the same
 *     reason (Helvetica renders them as "e" or blank).
 *   - Bullet-glyph variants (•, ●, ◦) sometimes appear inside prose
 *     where the model is mid-sentence; left untouched in lists (the
 *     list parser already handles bullets) but the inline form can
 *     stay since most PDF fonts handle U+2022.
 *
 * Idempotent: running it twice produces the same output.
 */
export function stripEm(s: string): string {
  return s
    .replace(/\s*—\s*/g, ', ')
    // Cleanup: ", , " can occur if input already had a comma right
    // before the em-dash; collapse to a single comma.
    .replace(/,\s*,/g, ',')
    // Whitespace before comma can sneak in via the replacement.
    .replace(/\s+,/g, ',')
    // Arrows → react-pdf Helvetica fallback is an apostrophe. Replace
    // before-and-after-spaced arrows with " to " so "Q1→Q2" reads
    // "Q1 to Q2". Pad with spaces if there were none originally so we
    // don't run words together.
    .replace(/\s*→\s*/g, ' to ')
    .replace(/\s*←\s*/g, ' from ')
    .replace(/\s*⇒\s*/g, ' > ')
    .replace(/\s*⇐\s*/g, ' < ')
    // Math comparators
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/≠/g, '!=')
    .replace(/±/g, '+/-')
    .replace(/×/g, 'x')
    .replace(/÷/g, '/');
}
