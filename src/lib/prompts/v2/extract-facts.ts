import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MODELS, MAX_OUTPUT_TOKENS } from '@/lib/anthropic/models';
import { streamWithOverloadRetry } from '@/lib/anthropic/client';
import { CycleFactsSchema, type CycleFacts } from './schemas';
import {
  renderContextForModel,
  listMissingInputs,
  subjectNaming,
  type CycleContext,
} from './context';
import { assertNotTruncated } from './post-process';

/**
 * Stage A — extract typed facts from raw cycle inputs.
 *
 * Uses Anthropic tool-use with a forced tool call so the model has to
 * return an object that matches CycleFactsSchema. This is the load-
 * bearing stage: every downstream stage references these facts instead
 * of re-reading raw inputs, which is what lets the rubric in Stage D be
 * checked deterministically.
 */

const FACTS_TOOL_NAME = 'submit_cycle_facts';

const FACTS_TOOL_INPUT_SCHEMA = z.toJSONSchema(CycleFactsSchema, {
  // Anthropic tool input_schema rejects $ref / definitions in some
  // shapes — inline everything to keep the schema flat.
  reused: 'inline',
}) as Record<string, unknown>;

const SYSTEM_PROMPT = `You are a fact extractor for an executive coaching platform. Your job is to read the raw inputs of a coaching cycle (CEO intake, weekly journals, monthly reflection, KPIs, zoom transcript, prior reports) and return a structured CycleFacts object.

You are NOT writing prose. You are NOT a coach. You are an extractor — you find the things that are present in the inputs and report them with citations. If something is not present, leave it null or empty. Do not invent.

## What to extract

1. **goalCascade** — the 10x destination, the 90-day goal, the 30-day commitment as the CEO stated them THIS cycle. If the 10x goal changed mid-cycle (e.g. revenue → EBITDA, or one number → another), set driftDetected.changed=true and capture from/to/when. The stored 10x goal on the CEO profile is informational only — the goal cascade should reflect what was said in this cycle's inputs.

   **For each of the 90-day and 30-day goals**, also populate \`ninetyDayConstraint\` and \`thirtyDayConstraint\` with the underlying constraint or problem that goal is addressing — NOT a restatement of the goal. Pull the constraint language from the inputs (journals, transcript, reflection) where the CEO names *why* the goal exists. Examples:
   - 90-day goal: "Close the bank LOC" → ninetyDayConstraint: "cash flow is gating all growth"
   - 30-day goal: "Define Tipton's new identity and qualifying rules for prospects" → thirtyDayConstraint: "the team is treating every customer the same way"
   Leave null only when the inputs don't clearly state a constraint.

2. **effort.weekly** — CRITICAL: produce ONE entry per weekly journal entry found in the inputs. Read every journal block in the "### Weekly Journals" section, even if there are gaps in week numbers (e.g. Week 1, Week 3, Week 4 with no Week 2 — that's still THREE entries, not one). For team cycles, each member's journal for each week is its own entry. Capture quantified minutes where stated; if a journal exists but minutes aren't stated, still emit an entry with \`minutes: null\` and what you found in \`note\`.

   Before submitting, count the weekly entries in your effort.weekly array against the number of "### Weekly Journals" entries in the input. If they don't match, add a string to \`extractionWarnings\` explaining the discrepancy (e.g. "I found 5 weekly journal blocks in the inputs but extracted only 3 effort entries — Week 4 entries for both members did not state minutes").

   **Do NOT** put "Weeks X–Y missing" complaints into \`effort.anomalies\` unless the journal numbers actually skip a week. \`anomalies\` describes the *data* (e.g. "a journal exists but never quantifies minutes"); \`extractionWarnings\` describes *your* extraction confidence.

3. **stakeholders** — every named person who recurs across journals/transcript/reflection (not the CEO themselves, not the coach, not team members of this coaching team). Include role if known. \`appearsIn\` lists which inputs they appear in.

   For each stakeholder, populate \`coachOnlyBackground\` with any background context the CEO already knows but the coach needs visible — family ties, employment status, remote-work history, prior decline, the CEO's personal relationship to them. Examples:
   - "Michael" → coachOnlyBackground: "Dave's nephew; head of sales; 100% remote since COVID; declining performance for ~1 year"
   - "Rick Crossland" → coachOnlyBackground: "external recruiter; was inside one of the two failed VP BizDev hires"
   This field exists so the drafter can keep CEO-facing text clean while still surfacing background in coachReviewFlags. Leave null when no background context appears in the inputs.

4. **emotionalEvents** — personal events that materially affected the cycle (family loss, health, major personal stress). Set affectedCycle=true if effort dipped or commitments slipped because of it. Cite the source.

5. **constraint** — the single highest-leverage constraint named THIS cycle. Whether it moved (got smaller, got named more precisely, got partially solved). Cite the source.

6. **evidenceClaims** — the load-bearing array. Every quantitative fact, every named outcome, every concrete change. Each claim must have a sourceRef (kind + locator + quote). The Stage C drafter is required to ground each win/challenge in one of these claims, so be thorough — extract more rather than fewer.

7. **commitments** — open commitments the CEO made this cycle, with owner + deadline if stated. Drives the suggestedNextSteps section downstream.

8. **coachReviewFlags** — meta-observations the coach should see BEFORE sending the report. Examples: "10x goal changed mid-month — needs to be locked", "constraint hasn't moved in 2 cycles", "client mentioned major personal event, handle with care". These are visible to the coach in the UI but never to the CEO.

   **Title style:** every flag title should be an imperative phrase (verb-first), not a declarative sentence. The downstream renderer surfaces titles as scannable action prompts.
   - ✅ "Lock the 10x goal at the top of June 10"
   - ✅ "Open with a personal check-in before accountability"
   - ✅ "Probe Megalabs root cause"
   - ❌ "The 10x goal conflicts with the team profile" (declarative — reframe as an imperative)

9. **nextSessionDate** — if the transcript or session notes name a specific date for the next coaching session, capture it as free text (e.g. "June 10, 2026"). Null if no follow-up was explicitly scheduled.

10. **extractionWarnings** — populate with anything you noticed about your own extraction confidence: "I had to infer the 30-day goal from Week 1 journal because monthlyGoals input was blank", "the transcript references 'two banks' but only one was named so I extracted one stakeholder", "the Megalabs commitment date is mentioned but I couldn't determine if it's April 22 or April 22 of next year". These become [INFO] coach flags downstream — they exist so the coach knows what to spot-check.

## Citation rules

- Every claim, emotional event, and constraint MUST cite a source.
- locator is free-text — "Week 2 journal", "transcript ~14:00", "KPI: EBITDA", "intake question 3". It just needs to point a coach at the source.
- quote is the verbatim or near-verbatim excerpt that supports the claim. Keep it short (under 30 words) but specific.
- If you can't cite something, don't claim it.

## Style

- Be direct. No softening, no hedging.
- Capture exact numbers when they exist (e.g. "$3.5M EBITDA tracking toward $5M", not "EBITDA is up").
- Capture exact phrases the CEO used when they're load-bearing (e.g. "I am the bottleneck", "two banks in final discussions").
- Don't moralise or interpret — just extract.

Call the ${FACTS_TOOL_NAME} tool with your extracted facts. Don't return any prose.`;

export type ExtractFactsResult = {
  facts: CycleFacts;
  modelUsed: string;
  missing: string[];
};

export async function extractFacts(ctx: CycleContext): Promise<ExtractFactsResult> {
  const missing = listMissingInputs(ctx);
  const missingWarning = missing.length > 0
    ? `\n\n⚠️ MISSING INPUTS: ${missing.join(', ')}. Extract only what is present. Don't invent.`
    : '';

  // When this is a team cycle, hint the extractor that journals carry
  // author bylines and claims should be attributable to the member
  // whose input they came from. We carry attribution via the locator
  // field on sourceRef ("David's Week 2 journal") rather than adding a
  // new schema field — keeps the existing CycleFacts shape stable.
  const naming = subjectNaming(ctx);
  // Gate on `ctx.team` (team exists), NOT naming.isTeam (active-member
  // count > 1). renderContextForModel tags journals with author bylines
  // whenever a team exists, so the extractor needs the attribution hint on
  // the same condition. Otherwise a team collapsed to one active member
  // (succession) would render multi-author bylines with no instruction to
  // attribute them.
  const teamHint = ctx.team
    ? `

## TEAM CYCLE — attribution matters
This cycle belongs to a coaching team (${naming.subjectFullLabel}). Journals and transcripts above are tagged with the authoring team member's name in their titles ("David's Weekly Journal — Week 2 …"). When you build evidenceClaims, stakeholders, emotionalEvents, and commitments:
- The team has ${naming.firstNames.length} members: ${naming.firstNames.join(', ')}. DON'T list the team's own members in \`stakeholders\` — they are the subjects of the report, not external stakeholders.
- For every claim, set sourceRef.locator to include the authoring member when relevant: "David's Week 2 journal", "Dave's Monthly Reflection", "Joint coaching transcript ~14:00". This lets the drafter attribute the claim to the right person.
- emotionalEvents and commitments tied to one specific member must say so in the locator + description.
- The 10x goal is TEAM-LEVEL — extract it from any member's input (they should agree) and capture any drift as you would for a solo CEO.
`
    : '';

  const userPrompt = `Extract CycleFacts from the following cycle inputs.

${renderContextForModel(ctx)}
${teamHint}${missingWarning}

Call the ${FACTS_TOOL_NAME} tool now.`;

  // Sonnet — Stage A is load-bearing for the *pipeline* (every downstream
  // stage cites these facts), but the task itself is structured
  // extraction with explicit source citations, not creative prose. Sonnet
  // 4.6 handles tool-call extraction with citations as well as Opus and
  // returns ~3× faster; on a typical cycle this saves ~90s of wall time
  // off the perceived "first stage" wait. Stages C (draft) and E (refine)
  // remain on Opus because the output literally lands in the CEO's email
  // and the prose-quality gap shows there.
  const modelId = MODELS.draft;
  const maxTokens = MAX_OUTPUT_TOKENS[modelId];

  // First attempt — fresh prompt.
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];
  const firstAttempt = await runFactsCall(modelId, maxTokens, messages);
  const firstParsed = CycleFactsSchema.safeParse(firstAttempt.toolInput);
  if (firstParsed.success) {
    return {
      facts: appendJournalCountWarning(firstParsed.data, ctx),
      modelUsed: modelId,
      missing,
    };
  }

  // One-shot retry: feed the validation error back to the model so it can
  // fix the malformed tool call. The schema is intentionally strict —
  // if the model omits a field consistently, this retry will surface
  // whether it's a transient glitch (retry succeeds) or a real
  // prompt/input-data problem (retry also fails, full diagnostic logs
  // tell us which).
  const errorSummary = formatZodIssues(firstParsed.error);
  // Log the actual tool input so when this fires again we can see what
  // the model actually sent. Top-level keys + a 500-char preview is
  // enough to diagnose without dumping the full payload to the logs.
  const toolInputPreview = (() => {
    try {
      const json = JSON.stringify(firstAttempt.toolInput);
      const keys =
        firstAttempt.toolInput && typeof firstAttempt.toolInput === 'object'
          ? Object.keys(firstAttempt.toolInput as Record<string, unknown>).join(', ')
          : '(non-object)';
      return `keys=[${keys}] preview=${json.slice(0, 500)}`;
    } catch {
      return '(unserializable)';
    }
  })();
  console.warn(
    `Stage A: first attempt failed Zod validation, retrying.\n  issues:\n${errorSummary}\n  toolInput: ${toolInputPreview}`,
  );
  messages.push(
    {
      role: 'assistant',
      content: firstAttempt.message.content,
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: firstAttempt.toolUseId,
          is_error: true,
          content: `The tool input failed schema validation. Fix these issues and call ${FACTS_TOOL_NAME} again with the corrected payload:\n\n${errorSummary}`,
        },
      ],
    },
  );

  const retry = await runFactsCall(modelId, maxTokens, messages);
  const retryParsed = CycleFactsSchema.safeParse(retry.toolInput);
  if (!retryParsed.success) {
    throw new Error(
      `Stage A: tool output failed CycleFactsSchema validation after retry — ${formatZodIssues(retryParsed.error)}`,
    );
  }
  return {
    facts: appendJournalCountWarning(retryParsed.data, ctx),
    modelUsed: modelId,
    missing,
  };
}

/**
 * Belt-and-braces guard against the "Stage A undercounts journals" bug
 * we shipped with the May 2026 Tipton Mills run (5 journal blocks in the
 * inputs → only 2 effort entries → report said "Weeks 2–4 missing"
 * when Weeks 3 and 4 were actually present).
 *
 * If the number of weekly effort entries Stage A produced is materially
 * lower than the number of weekly journal blocks the context contained,
 * we append an explicit extractionWarning so the discrepancy surfaces
 * as an [INFO] coach flag and the drafter knows not to claim "only
 * Week N submitted". The warning carries the actual numbers so a coach
 * can spot-check immediately.
 */
function appendJournalCountWarning(
  facts: CycleFacts,
  ctx: CycleContext,
): CycleFacts {
  const journalCount = ctx.journals.length;
  const effortCount = facts.effort.weekly.length;
  // Allow effort entries to undershoot journals only by a small margin
  // (journals can exist without ever quantifying minutes — that's a
  // genuine data gap, not an extraction bug). Trigger the warning only
  // when there's a meaningful gap: at least one journal is unaccounted
  // for AND the extracted count is less than 80% of the journal count.
  if (
    journalCount === 0 ||
    effortCount >= journalCount ||
    effortCount >= Math.ceil(journalCount * 0.8)
  ) {
    return facts;
  }
  const warning =
    `Stage A extracted ${effortCount} weekly effort entries from ${journalCount} weekly journal blocks in the inputs. ` +
    `Some journals may not have quantified minutes — verify before claiming weeks are "missing" in CEO-facing text.`;
  // De-dupe: don't append the same warning twice if a regenerate loop
  // already added one.
  if (facts.extractionWarnings.some((w) => w.includes('weekly effort entries from'))) {
    return facts;
  }
  return {
    ...facts,
    extractionWarnings: [...facts.extractionWarnings, warning],
  };
}

/** Single tool-use round-trip — extracted so the retry path can re-use
 *  it with an updated message history. Returns the raw assistant message
 *  (needed for the retry conversation) plus the parsed tool call. */
async function runFactsCall(
  modelId: string,
  maxTokens: number,
  messages: Anthropic.MessageParam[],
): Promise<{
  message: Anthropic.Message;
  toolInput: unknown;
  toolUseId: string;
}> {
  const message = await streamWithOverloadRetry(
    {
      model: modelId,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: FACTS_TOOL_NAME,
          description: 'Submit the structured CycleFacts extracted from the cycle inputs.',
          input_schema: FACTS_TOOL_INPUT_SCHEMA as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: FACTS_TOOL_NAME },
      messages,
    },
    'Stage A',
  );
  assertNotTruncated(message, 'Stage A', maxTokens);
  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === 'tool_use' && b.name === FACTS_TOOL_NAME,
  );
  if (!toolUse) {
    throw new Error('Stage A: model did not call the submit_cycle_facts tool');
  }
  return { message, toolInput: toolUse.input, toolUseId: toolUse.id };
}

/** Compact, human-readable summary of a ZodError — used both for the
 *  retry prompt and for the user-facing error string. Bullet list of
 *  `path: message` lines so a coach can see WHICH field broke without
 *  reading the full structured error blob. */
function formatZodIssues(err: z.ZodError): string {
  const lines = err.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `- ${path}: ${issue.message}`;
  });
  if (err.issues.length > 8) {
    lines.push(`- … and ${err.issues.length - 8} more issue(s)`);
  }
  return lines.join('\n');
}
