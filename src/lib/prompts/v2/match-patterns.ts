import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MODELS } from '@/lib/anthropic/models';
import { PatternsSchema, type Patterns, type CycleFacts } from './schemas';
import type { CycleContext } from './context';

const anthropic = new Anthropic();

/**
 * Stage B — given the current cycle's CycleFacts plus prior cycles'
 * Facts and patternObservations, identify cross-cycle patterns:
 * carrying-forward strengths, evolving behaviours, resolving issues,
 * and anything new that only appeared this cycle.
 *
 * Short-circuits to `{ isFirstCycle: true, ... empty arrays }` if there
 * is no prior context — the drafter is then required to say so
 * explicitly instead of fabricating a pattern from one data point.
 */

const PATTERNS_TOOL_NAME = 'submit_patterns';
const PATTERNS_TOOL_INPUT_SCHEMA = z.toJSONSchema(PatternsSchema, {
  reused: 'inline',
}) as Record<string, unknown>;

const SYSTEM_PROMPT = `You are a cross-cycle pattern matcher for an executive coaching platform. You receive the current cycle's CycleFacts (typed) plus the same shape for prior cycles. Your job is to compare them and identify recurring or evolving patterns.

## Pattern categories

- **carryingForward** — behaviours, strengths, or weaknesses that have appeared in 2+ cycles. firstSeenIn = the earliest cycle label where you can find it; evolution = how it has changed (or "stable" if unchanged).
- **evolving** — patterns that visibly shifted THIS cycle. The pattern existed before but got more specific, more severe, less severe, more deliberate, etc.
- **resolving** — patterns that were present before and are now closing. howResolved = the specific change that ended it.
- **newThisCycle** — patterns that only appeared this cycle. Plain strings — these are observations, not yet patterns until they recur.

## Rules

- Only call something a pattern if it appears in 2+ cycles' Facts. A single new observation goes in newThisCycle.
- Quote specifics. "You're still in the weeds" beats "operational tendency". Use the language the prior cycles used.
- If priorFacts is empty, set isFirstCycle=true and leave all arrays empty. The drafter will say so explicitly.
- Be precise. The drafter will inline these into the report's patternObservations section.

Call the ${PATTERNS_TOOL_NAME} tool. No prose.`;

export type MatchPatternsResult = {
  patterns: Patterns;
  modelUsed: string;
};

export async function matchPatterns(args: {
  ctx: CycleContext;
  currentFacts: CycleFacts;
}): Promise<MatchPatternsResult> {
  const { ctx, currentFacts } = args;

  if (ctx.isFirstCycle) {
    // Skip the model call — there's nothing to match against.
    return {
      patterns: {
        carryingForward: [],
        evolving: [],
        resolving: [],
        newThisCycle: [],
        isFirstCycle: true,
      },
      modelUsed: 'short-circuit:first-cycle',
    };
  }

  const priorFactsBlock = ctx.priorFacts
    .filter((p) => p.facts !== null)
    .map((p) => `### ${p.cycleLabel}\n${JSON.stringify(p.facts, null, 2)}`)
    .join('\n\n---\n\n');

  const priorPatternsBlock = ctx.previousReports
    .map((r) => ({ label: r.cycleLabel, text: (r.patternObservations ?? '').trim() }))
    .filter((r) => r.text.length > 0)
    .map((p) => `### ${p.label} (prior patternObservations prose)\n${p.text}`)
    .join('\n\n---\n\n');

  const userPrompt = `## Current cycle facts (Cycle: ${ctx.cycle.label})
\`\`\`json
${JSON.stringify(currentFacts, null, 2)}
\`\`\`

## Prior cycles' facts (oldest → newest)
${priorFactsBlock || '(no prior CycleFacts rows — only legacy patternObservations prose available, see below)'}

## Prior cycles' patternObservations prose (legacy fallback)
${priorPatternsBlock || '(none)'}

Now identify the cross-cycle patterns. Call ${PATTERNS_TOOL_NAME}.`;

  const modelId = MODELS.draft;

  const message = await anthropic.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: PATTERNS_TOOL_NAME,
        description: 'Submit cross-cycle patterns found between current and prior cycles.',
        input_schema: PATTERNS_TOOL_INPUT_SCHEMA as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: PATTERNS_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === PATTERNS_TOOL_NAME,
  );
  if (!toolUse) throw new Error('Stage B: model did not call submit_patterns');

  const parsed = PatternsSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(`Stage B: invalid patterns — ${parsed.error.message}`);
  }
  return { patterns: parsed.data, modelUsed: modelId };
}
