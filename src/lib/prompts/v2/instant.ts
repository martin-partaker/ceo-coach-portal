import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { streamWithOverloadRetry } from '@/lib/anthropic/client';
import { MODELS, MAX_OUTPUT_TOKENS } from '@/lib/anthropic/models';
import { buildPrompt } from '@/lib/prompts/builder';
import { stripEmDashesFromDraft, assertNotTruncated } from './post-process';
import { DraftedReportSchema, type DraftedReport } from './schemas';
import type { CycleContext } from './context';

export type InstantDraftResult = {
  drafted: DraftedReport;
  modelUsed: string;
  missing: string[];
};

/**
 * Single-shot legacy generator (the original v1 path). Calls the v1
 * prompt builder + one Anthropic call; no fact extraction, no pattern
 * matching, no critique. Faster than the v2 pipeline (~30–60s vs
 * ~70–150s for v2 quick) at the cost of less structural grounding.
 *
 * Output is adapted to the v2 DraftedReport shape (missing fields
 * filled with sensible defaults) so the modal renders it identically
 * to v2 output and the report row carries promptVersion: 3.
 */
export async function runInstantDraft(
  ctx: CycleContext,
): Promise<InstantDraftResult> {
  const { systemPrompt, userPrompt, missing } = await buildPrompt({
    cycle: ctx.cycle,
    ceo: ctx.ceo,
    coachName: ctx.coachName,
    previousReports: ctx.previousReports,
  });

  const modelId = MODELS.reportPrimary;
  const maxTokens = MAX_OUTPUT_TOKENS[modelId];

  const message = await streamWithOverloadRetry(
    {
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    },
    'Instant',
  );

  assertNotTruncated(message, 'Instant', maxTokens);

  const textBlock = message.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  if (!textBlock) throw new Error('Instant: no text response from model');

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(
      `Instant: response was not valid JSON — ${(e as Error).message}`,
    );
  }

  // The v1 prompt produces a subset of the v2 DraftedReport shape:
  // it has the email view + the report sub-object, but not the v2-only
  // `goalSummary` and `coachReviewFlags` fields. Fill those with
  // sensible defaults so DraftedReportSchema accepts the input and the
  // modal/PDF renderers don't trip on missing keys.
  const adapted = adaptV1ToV2(parsed);
  const validated = DraftedReportSchema.safeParse(adapted);
  if (!validated.success) {
    throw new Error(
      `Instant: drafted report failed schema validation — ${validated.error.message}`,
    );
  }

  return {
    drafted: stripEmDashesFromDraft(validated.data),
    modelUsed: modelId,
    missing,
  };
}

function adaptV1ToV2(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const obj = input as Record<string, unknown>;
  const report = obj.report as Record<string, unknown> | undefined;
  if (!report) return input;
  return {
    ...obj,
    report: {
      ...report,
      goalSummary: report.goalSummary ?? null,
      coachReviewFlags: Array.isArray(report.coachReviewFlags)
        ? report.coachReviewFlags
        : [],
    },
  };
}
