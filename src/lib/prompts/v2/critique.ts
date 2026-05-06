import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MODELS } from '@/lib/anthropic/models';
import {
  CritiqueSchema,
  RUBRIC_ITEMS,
  type Critique,
  type CycleFacts,
  type Patterns,
  type DraftedReport,
} from './schemas';

const anthropic = new Anthropic();

/**
 * Stage D — rubric critic.
 *
 * Cheap (Haiku) call that scores a drafted report against the 9-row
 * rubric, returns which sections need a rewrite, and a one-sentence
 * "topFix" for the next pass. The drafter then rewrites only the weak
 * sections, capped at 2 revision loops.
 */

const CRITIQUE_TOOL_NAME = 'submit_critique';
const CRITIQUE_TOOL_INPUT_SCHEMA = z.toJSONSchema(CritiqueSchema, {
  reused: 'inline',
}) as Record<string, unknown>;

const SYSTEM_PROMPT = `You are a quality critic for an executive coaching platform's monthly report generator. You receive a drafted report plus the typed CycleFacts and Patterns it should have been grounded in, and you score it against a fixed 9-row rubric.

You are not rewriting. You are not softening. You are checking each rubric item: pass or fail, and if fail, which sections need a rewrite to fix it.

## The 9-row rubric

${RUBRIC_ITEMS.map((r, i) => `${i + 1}. **${r.id}** — ${r.label}\n   Requirement: ${r.requirement}`).join('\n\n')}

## Rules

- For each item, set pass=true ONLY if the requirement is fully met. If partially met, pass=false with a specific reason.
- reason must be specific. "Doesn't cite numbers" is bad. "progressSummary uses 'strong progress' but never references the $3.5M EBITDA or 330 min/week from facts.evidenceClaims" is good.
- fixInSections lists the exact sections to rewrite. Be minimal — name only sections that need work, not the whole report.
- weakSections at the top level is the deduplicated union of all fixInSections from failed items.
- pass at the top level is true ONLY if every item is pass=true.
- topFix is one sentence the drafter should hear most loudly when revising. Pick the highest-leverage fix. If everything passes, topFix=null.

Call the ${CRITIQUE_TOOL_NAME} tool. No prose.`;

export type CritiqueResult = {
  critique: Critique;
  modelUsed: string;
};

export async function critiqueReport(args: {
  facts: CycleFacts;
  patterns: Patterns;
  draft: DraftedReport;
}): Promise<CritiqueResult> {
  const { facts, patterns, draft } = args;

  const userPrompt = `Score this draft.

## CycleFacts
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

## Patterns
\`\`\`json
${JSON.stringify(patterns, null, 2)}
\`\`\`

## Drafted report
\`\`\`json
${JSON.stringify(draft, null, 2)}
\`\`\`

Now call ${CRITIQUE_TOOL_NAME}.`;

  const modelId = MODELS.classifier; // Haiku — rubric scoring is structured, doesn't need Sonnet/Opus

  const message = await anthropic.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: CRITIQUE_TOOL_NAME,
        description: 'Submit a rubric-based critique of the drafted report.',
        input_schema: CRITIQUE_TOOL_INPUT_SCHEMA as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: CRITIQUE_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === CRITIQUE_TOOL_NAME,
  );
  if (!toolUse) throw new Error('Stage D: model did not call submit_critique');

  const parsed = CritiqueSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(`Stage D: invalid critique — ${parsed.error.message}`);
  }

  // Recompute weakSections from items as a sanity guard against the model
  // skipping it. We dedupe + cap at the union of fixInSections.
  const computedWeak = Array.from(
    new Set(
      parsed.data.items
        .filter((i) => !i.pass)
        .flatMap((i) => i.fixInSections),
    ),
  );
  const weakSections = parsed.data.weakSections.length > 0
    ? Array.from(new Set([...parsed.data.weakSections, ...computedWeak]))
    : computedWeak;

  return {
    critique: { ...parsed.data, weakSections },
    modelUsed: modelId,
  };
}
