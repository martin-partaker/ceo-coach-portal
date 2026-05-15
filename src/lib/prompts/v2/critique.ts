import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MODELS, MAX_OUTPUT_TOKENS } from '@/lib/anthropic/models';
import { streamWithOverloadRetry } from '@/lib/anthropic/client';
import {
  CritiqueSchema,
  RUBRIC_ITEMS,
  type Critique,
  type CycleFacts,
  type Patterns,
  type DraftedReport,
} from './schemas';
import { assertNotTruncated } from './post-process';


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

const SYSTEM_PROMPT = `You are a senior editor reviewing a monthly coaching report before it goes to the CEO. A coach will read your notes and decide what to revise — so every comment you write has to be readable BY A COACH, not by a developer.

You are not rewriting. You are not softening. You are checking each rubric item: pass or fail, and if fail, which sections need a rewrite to fix it.

## The 9-row rubric

${RUBRIC_ITEMS.map((r, i) => `${i + 1}. **${r.id}** — ${r.label}\n   Requirement: ${r.requirement}`).join('\n\n')}

## How to score

- For each item, set pass=true ONLY if the requirement is fully met. If partially met, pass=false.
- pass at the top level is true ONLY if every item is pass=true.
- weakSections is the deduplicated union of all fixInSections from failed items.
- topFix is the single most important change a coach would want to make. One short sentence. If everything passes, topFix=null.

## Writing the \`reason\` field — READ THIS CAREFULLY

The reason is shown verbatim to a coach in the report sidebar. Write it the way a thoughtful editor would talk to another coach — plain English, specific, no jargon.

### NEVER use these terms in a reason (they're internal field names, not coach language):
- "facts.X", "evidenceClaims", "sourceRef", "fixInSections", "patternObservations", "schema"
- "the X field", "the X property", "did not populate"
- "Stage A / B / C / D", "the rubric", "tool input"
- JSON-flavoured phrasing in general

### Instead, use:
- "the journals show…", "the transcript mentions…", "this cycle's KPI for X is…"
- "the stakeholders Dave and Todd are named in the inputs but the report doesn't address them"
- "the wins read as generic — no dollar figures, no named accounts"
- "Pattern Observations reads as one block — could be 3–4 bullets so the coach can scan it"

### Good vs bad reason examples

❌ "progressSummary doesn't reference facts.evidenceClaims; no quantitative grounding."
✅ "Progress Summary calls the month 'strong' but never names the $3.5M EBITDA or the 330 min/week of focus time both of which are in the journals."

❌ "patternObservations should connect to facts.constraint.named."
✅ "The constraint 'cash runway' shows up clearly in the journals but Pattern Observations doesn't name it — the coach won't see the through-line."

❌ "challenges array missing stakeholder feedback."
✅ "Two stakeholders (Dave, Todd) are named in this cycle's inputs but Challenges only addresses David — the coach should call out the role-specific issue with each."

### fixInSections

Pick from the actual section names a coach would see in the report: progressSummary, keyWins, challenges, patternObservations, suggestedNextSteps, or for the email version: opening, wins_and_progress, honest_feedback, key_insight, commitments. Be minimal — only sections that actually need work.

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

  // Sonnet — the critic is the quality gate that decides whether the
  // drafter revises. It has to make calibrated comparison calls (e.g.
  // "does this paragraph cite a specific evidenceClaim, or is it
  // generic?"), which is judgment, not classification. A weak critic
  // either lets bad drafts through or burns Opus tokens on unneeded
  // revisions — both costlier than the Haiku→Sonnet delta on ≤3 calls.
  const modelId = MODELS.draft;

  const maxTokens = MAX_OUTPUT_TOKENS[modelId];
  // Streaming + overload-retry — see draft.ts (Stage C) for rationale.
  const message = await streamWithOverloadRetry(
    {
      model: modelId,
      max_tokens: maxTokens,
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
    },
    'Stage D',
  );

  assertNotTruncated(message, 'Stage D', maxTokens);

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
