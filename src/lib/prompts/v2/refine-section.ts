import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { MODELS, MAX_OUTPUT_TOKENS } from '@/lib/anthropic/models';
import { streamWithOverloadRetry } from '@/lib/anthropic/client';
import type {
  CycleFacts,
  Patterns,
  RefinableSection,
  DraftedReport,
} from './schemas';
import { renderContextForModel, subjectNaming, type CycleContext } from './context';
import { stripEm, assertNotTruncated } from './post-process';


/**
 * Stage E — per-section refinement chat.
 *
 * The coach iterates on a single section in a side panel. Each turn:
 *   - User: "make this more specific to the COO hire"
 *   - Model: returns a revised paragraph for ONLY that section.
 *
 * The full report stays untouched; only the targeted field is swapped
 * in. The chat history is persisted (reportRefinements table) so the
 * coach can scroll back / revert.
 *
 * Critically:
 *   - Pinned paragraphs from the same section are passed through and
 *     the model is told to keep them verbatim.
 *   - The CycleFacts, Patterns, and the *whole* current draft are in
 *     context so the model knows what surrounds the section.
 *   - Only the section's new value is returned (a string for prose
 *     fields, JSON-encoded array for list fields).
 */

const SYSTEM_TEMPLATE = (
  subjectHandle: string,
  isTeam: boolean,
  coachName: string,
  section: RefinableSection,
  isListField: boolean,
  reportGeneratedAt: string,
) => `You are ${coachName}, refining the "${section}" section of a monthly coaching summary you wrote for ${isTeam ? `your coaching team ${subjectHandle}` : `your CEO client ${subjectHandle}`}. The coach is iterating with you on this single section. Other sections of the report are NOT in play — only ${section}.

Report generation date: ${reportGeneratedAt}. Past dates in body text use historical tense.

## Inputs you have
- The full current drafted report (so you know what surrounds this section — every change must stay coherent with the other sections).
- **CycleFacts** — typed extraction of every concrete fact in the cycle, with sourceRefs back to journals / transcripts / KPIs. Cite these.
- **Patterns** — cross-month observations (carryingForward / evolving / resolving / newThisCycle / intraMonthTrends).
- **Raw cycle inputs** — the original journals, monthly reflection, transcript, KPI series. Use these when the coach asks for something that's NOT in CycleFacts but IS in the raw inputs (a specific phrase from a journal, a number not picked up by extraction, etc.).
- Any pinned paragraphs the coach wants kept verbatim.
- The chat history with the coach about THIS section.

## Output rules

You will return ONLY the new value for the "${section}" section. ${isListField
  ? 'It is a list field — return a JSON array of strings, e.g. ["item 1", "item 2"]. Each item must start with a **bold lead-in clause ending in a period**, followed by the detail sentence. No prose outside the array, no markdown fences, no explanation.'
  : section === 'closing'
    ? 'It is the closing sentence — return a plain string (no JSON, no markdown fences). The sentence must reference a SPECIFIC event from this month (a name, number, decision, or moment that actually happened) and must not be a generic encouragement. The next-session date is managed separately and is not part of this refinement.'
    : 'It is a prose field — return a plain string with no markdown fences and no prefatory commentary. Just the new content.'}

## Style rules (the same standards the original draft was built against — preserve them)
- Match the coach's voice — warm but direct, second-person to ${subjectHandle}${isTeam ? ` (joint plural "you" / "the two of you" for joint moments; THIRD-person + first name when one specific member is the subject of the beat — never switch to second-person singular for one member of a pair, that's inconsistent)` : ''}.
- Every concrete claim must trace back to a CycleFact's evidenceClaim or a verbatim line in the raw inputs. DO NOT invent numbers, names, dates, events, or quotes.
- Preserve specificity: if the current section names a person, a number, or a deadline, the refined version should still have at least one of each (unless the coach explicitly removes them).
- **Bold lead-in clauses** on every bullet in keyWins / challenges / suggestedNextSteps. Max 5 bullets per section (up to 7 only for true ties).
- For suggestedNextSteps, keep the italic Altitude Matrix tag immediately after the bold lead-in: \`**Lead-in.** *(Eliminate / Leadership)* Detail...\`. Dimension is one or two of Elevate / Eliminate / Execute; pillar is exactly one of Self / Leadership / Company.
- Use **"month"** in CEO-facing text, never "cycle".
- Use Flight System vocabulary naturally where it fits (Flight Plan, Altitude Matrix, Momentum Loop, lift / drag / thrust, Elevate / Eliminate / Execute, Self / Leadership / Company).
- No transcript timestamps in body text ("at ~25:00" etc.) — reference the session generically.
- No data-quality caveats in CEO-facing text ("inferred from Week 1", "monthly goals not provided") — those live in coachReviewFlags only.
- No background context on people the CEO already knows (family ties, employment, remote status) — also coachReviewFlags only.
- Past dates use historical tense ("the estimated close date was ~May 19", not "closing by May 19" when May 19 has passed).
- If the coach asks to keep a pinned paragraph, include it verbatim somewhere in your output.
- If the coach's request can't be honored from the available facts or raw inputs, say so in a single line and stop. Don't make something up to comply.`;

export type RefinementHistoryItem = { role: 'user' | 'assistant'; content: string };

export type RefineSectionArgs = {
  ctx: CycleContext;
  facts: CycleFacts;
  patterns: Patterns;
  /** True when CycleFacts + Patterns were actually extracted (i.e. the
   *  cycle has been through Stage A). False when the report was
   *  generated via the Instant / Quick path that skips Stage A — the
   *  facts/patterns args are an empty skeleton in that case and the
   *  refine prompt tells the model to rely on raw inputs instead. */
  factsAvailable: boolean;
  currentDraft: DraftedReport;
  section: RefinableSection;
  /** Coach's new message for this turn. */
  userMessage: string;
  /** Chat history from prior turns on this section (oldest → newest). */
  history: RefinementHistoryItem[];
  /** Pinned paragraphs in THIS section that must be preserved. */
  pinnedParagraphs?: string[];
};

export type RefineSectionResult = {
  /** The new value of the section — string for prose, string[] for list. */
  newValue: string | string[];
  /** A single string snapshot of the new value (joined for list fields)
   *  — used as the assistant turn's sectionSnapshot in the chat log. */
  snapshot: string;
  modelUsed: string;
  rawText: string;
};

const LIST_FIELDS: ReadonlySet<RefinableSection> = new Set([
  'keyWins',
  'challenges',
  'suggestedNextSteps',
]);

function getCurrentSectionValue(
  draft: DraftedReport,
  section: RefinableSection,
): string | string[] {
  switch (section) {
    case 'progressSummary':
      return draft.report.progressSummary ?? '';
    case 'keyWins':
      return draft.report.keyWins ?? [];
    case 'challenges':
      return draft.report.challenges ?? [];
    case 'patternObservations':
      return draft.report.patternObservations ?? '';
    case 'suggestedNextSteps':
      return draft.report.suggestedNextSteps ?? [];
    case 'closing':
      // Refine targets only the closing sentence — nextSessionDate is
      // a structured date, not prose, so it stays untouched. The
      // sentence is treated as a plain string field.
      return draft.report.closing?.sentence ?? '';
    case 'opening':
      return draft.opening ?? '';
    case 'wins_and_progress':
      return draft.wins_and_progress ?? '';
    case 'honest_feedback':
      return draft.honest_feedback ?? '';
    case 'key_insight':
      return draft.key_insight ?? '';
    case 'commitments':
      return draft.commitments ?? '';
    default: {
      const _exhaustive: never = section;
      void _exhaustive;
      return '';
    }
  }
}

export async function refineSection(args: RefineSectionArgs): Promise<RefineSectionResult> {
  const {
    ctx,
    facts,
    patterns,
    factsAvailable,
    currentDraft,
    section,
    userMessage,
    history,
    pinnedParagraphs = [],
  } = args;
  const naming = subjectNaming(ctx);
  const isList = LIST_FIELDS.has(section);

  const currentValue = getCurrentSectionValue(currentDraft, section);
  const currentValueRendered = Array.isArray(currentValue)
    ? JSON.stringify(currentValue, null, 2)
    : currentValue;

  // Initial user turn carries the FULL context the drafter saw — typed
  // facts, patterns, the entire current draft, AND the raw rendered
  // cycle inputs (journals, transcripts, KPIs, monthly reflection,
  // prior reports). Without the raw inputs, a refinement like "pull in
  // that specific line from Dave's Week 3" is impossible to honor when
  // the line never made it into the typed extraction. The extra tokens
  // are worth it — refinements are infrequent and high-stakes.
  // When the cycle has been through Stage A we send the typed
  // CycleFacts + Patterns JSON. When it hasn't (Instant / Quick path),
  // we send a clear "not extracted — work from raw inputs" note so the
  // model knows to ground in the verbatim cycle inputs instead. The
  // raw inputs block is ALWAYS sent — that's the load-bearing context
  // for refinements like "pull in that specific quote from Week 3".
  const factsBlock = factsAvailable
    ? ['## CycleFacts (typed extraction with citations)', '```json', JSON.stringify(facts, null, 2), '```'].join('\n')
    : '## CycleFacts\n*Not extracted for this cycle (the report was generated via the Instant / Quick path which skips Stage A). Use the raw inputs below to ground any changes.*';
  const patternsBlock = factsAvailable
    ? ['## Patterns (cross-cycle)', '```json', JSON.stringify(patterns, null, 2), '```'].join('\n')
    : '## Patterns\n*Not computed for this cycle. Use the raw inputs + prior reports below to identify any cross-cycle patterns yourself if the coach asks.*';

  const contextTurnContent = [
    `## Current full draft (for surrounding-context awareness)`,
    '```json',
    JSON.stringify(currentDraft, null, 2),
    '```',
    '',
    factsBlock,
    '',
    patternsBlock,
    '',
    `## Raw cycle inputs (verbatim — ${factsAvailable ? 'use when refinement requires something not captured in CycleFacts' : 'the PRIMARY source of truth since CycleFacts is absent'})`,
    renderContextForModel(ctx),
    '',
    `## Current value of "${section}"`,
    isList ? '```json' : '"""',
    currentValueRendered,
    isList ? '```' : '"""',
    '',
    pinnedParagraphs.length > 0
      ? `## Pinned paragraphs (must appear verbatim)\n${pinnedParagraphs
          .map((p, i) => `### Pin ${i + 1}\n"""\n${p}\n"""`)
          .join('\n\n')}`
      : '',
    '',
    'I will now send refinement requests in this chat. Each turn, return ONLY the new value of the section in the format described in the system prompt. No prefatory commentary.',
  ]
    .filter((s) => s !== '')
    .join('\n');

  // We always start the conversation with the context turn, then append
  // prior chat history, then the new user message. This keeps the
  // model's view of the section consistent across regenerations.
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: contextTurnContent },
    {
      role: 'assistant',
      content:
        'Acknowledged. Send refinement requests and I will return the new section value only.',
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  const modelId = MODELS.reportPrimary;
  const maxTokens = MAX_OUTPUT_TOKENS[modelId];

  const reportGeneratedAt = new Date().toISOString().slice(0, 10);
  // Streaming + overload-retry — see draft.ts (Stage C) for rationale.
  const message = await streamWithOverloadRetry(
    {
      model: modelId,
      max_tokens: maxTokens,
      system: SYSTEM_TEMPLATE(
        naming.subjectHandle,
        naming.isTeam,
        ctx.coachName,
        section,
        isList,
        reportGeneratedAt,
      ),
      messages,
    },
    'Stage E',
  );

  assertNotTruncated(message, 'Stage E', maxTokens);

  const textBlock = message.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  if (!textBlock) throw new Error('Stage E: no text response from model');
  const rawText = textBlock.text.trim();

  if (isList) {
    let parsed: unknown;
    try {
      // Strip optional ```json fences in case the model adds them despite instructions.
      const cleaned = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Stage E: list section "${section}" response was not valid JSON`);
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error(`Stage E: list section "${section}" must be a JSON array of strings`);
    }
    const newValue = (parsed as string[]).map(stripEm);
    return {
      newValue,
      snapshot: newValue.join('\n• '),
      modelUsed: modelId,
      rawText,
    };
  }

  const cleanedText = stripEm(rawText);
  return {
    newValue: cleanedText,
    snapshot: cleanedText,
    modelUsed: modelId,
    rawText,
  };
}

/** Apply a refinement result back into a DraftedReport, returning a new
 *  draft. The router uses this to compute the post-merge contentJson
 *  before persisting. */
export function applyRefinement(
  draft: DraftedReport,
  section: RefinableSection,
  newValue: string | string[],
): DraftedReport {
  const next: DraftedReport = {
    ...draft,
    report: { ...draft.report },
  };
  switch (section) {
    case 'progressSummary':
      next.report.progressSummary = newValue as string;
      break;
    case 'keyWins':
      next.report.keyWins = newValue as string[];
      break;
    case 'challenges':
      next.report.challenges = newValue as string[];
      break;
    case 'patternObservations':
      next.report.patternObservations = newValue as string;
      break;
    case 'suggestedNextSteps':
      next.report.suggestedNextSteps = newValue as string[];
      break;
    case 'closing': {
      // Only the sentence is refined — preserve nextSessionDate from
      // the prior draft. If there was no closing block at all, the new
      // sentence creates one with nextSessionDate=null (the UI can
      // edit the date separately).
      const sentence = (newValue as string).trim();
      if (!sentence) {
        next.report.closing = null;
      } else {
        next.report.closing = {
          sentence,
          nextSessionDate: draft.report.closing?.nextSessionDate ?? null,
        };
      }
      break;
    }
    case 'opening':
      next.opening = newValue as string;
      break;
    case 'wins_and_progress':
      next.wins_and_progress = newValue as string;
      break;
    case 'honest_feedback':
      next.honest_feedback = newValue as string;
      break;
    case 'key_insight':
      next.key_insight = newValue as string;
      break;
    case 'commitments':
      next.commitments = newValue as string;
      break;
    default: {
      const _exhaustive: never = section;
      void _exhaustive;
    }
  }
  return next;
}
