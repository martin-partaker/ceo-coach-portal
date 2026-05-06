import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MODELS, MAX_OUTPUT_TOKENS } from '@/lib/anthropic/models';
import { streamWithOverloadRetry } from '@/lib/anthropic/client';
import { CycleFactsSchema, type CycleFacts } from './schemas';
import { renderContextForModel, listMissingInputs, type CycleContext } from './context';
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

2. **effort.weekly** — for each weekly journal, extract the time spent on 10x work if quantified (e.g. "330 minutes/week", "12-15 hour days"). If not quantified, leave minutes null and put what you found in note.

3. **stakeholders** — every named person who recurs across journals/transcript/reflection (not the CEO themselves, not the coach). Include role if known. appearsIn lists which inputs they appear in.

4. **emotionalEvents** — personal events that materially affected the cycle (family loss, health, major personal stress). Set affectedCycle=true if effort dipped or commitments slipped because of it. Cite the source.

5. **constraint** — the single highest-leverage constraint named THIS cycle. Whether it moved (got smaller, got named more precisely, got partially solved). Cite the source.

6. **evidenceClaims** — the load-bearing array. Every quantitative fact, every named outcome, every concrete change. Each claim must have a sourceRef (kind + locator + quote). The Stage C drafter is required to ground each win/challenge in one of these claims, so be thorough — extract more rather than fewer.

7. **commitments** — open commitments the CEO made this cycle, with owner + deadline if stated. Drives the suggestedNextSteps section downstream.

8. **coachReviewFlags** — meta-observations the coach should see BEFORE sending the report. Examples: "10x goal changed mid-month — needs to be locked", "constraint hasn't moved in 2 cycles", "client mentioned major personal event, handle with care". These are visible to the coach in the UI but never to the CEO.

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

  const userPrompt = `Extract CycleFacts from the following cycle inputs.

${renderContextForModel(ctx)}
${missingWarning}

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
    return { facts: firstParsed.data, modelUsed: modelId, missing };
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
  return { facts: retryParsed.data, modelUsed: modelId, missing };
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
