import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { streamWithOverloadRetry } from '@/lib/anthropic/client';
import { db } from '@/db';
import { curriculum } from '@/db/schema';
import { asc } from 'drizzle-orm';
import { MODELS, MAX_OUTPUT_TOKENS } from '@/lib/anthropic/models';
import {
  DraftedReportSchema,
  RUBRIC_ITEMS,
  type DraftedReport,
  type CycleFacts,
  type Patterns,
  type RefinableSection,
} from './schemas';
import {
  renderContextForModel,
  listMissingInputs,
  subjectNaming,
  type CycleContext,
} from './context';
import { FEWSHOT_BLOCK } from './fewshot';
import { stripEmDashesFromDraft, assertNotTruncated } from './post-process';


/**
 * Stage C — drafter v2.
 *
 * Same output shape v1 returned (so the existing UI keeps working) but
 * with three structural improvements:
 *   1. CycleFacts + Patterns are passed as structured JSON the drafter
 *      MUST cite, not raw inputs the drafter has to re-extract.
 *   2. The system prompt embeds the rubric Stage D will check against,
 *      so the drafter is solving for the same bar the critic enforces.
 *   3. The system prompt embeds gold-standard exemplars (Tipton Mills,
 *      nonprofit-good) cached as the prefix — the model sees what
 *      "good" looks like every call, at no additional per-call cost.
 *
 * Supports two modes:
 *   - First draft: weakSections=undefined, pinnedParagraphs=[]
 *   - Revision  : weakSections=['challenges', ...], priorDraft=...,
 *                 pinnedParagraphs=[ { section, text }, ... ] preserved
 */

type DraftArgs = {
  ctx: CycleContext;
  facts: CycleFacts;
  patterns: Patterns;
  /** When set, the drafter is told to rewrite ONLY these sections and
   *  to keep priorDraft for everything else. */
  weakSections?: RefinableSection[];
  priorDraft?: DraftedReport;
  pinnedParagraphs?: Array<{ section: RefinableSection; text: string }>;
  /** A short critic instruction ("the most important thing to fix is …")
   *  surfaced from Stage D. Empty for first draft. */
  topFix?: string | null;
};

export type DraftResult = {
  drafted: DraftedReport;
  modelUsed: string;
  systemPrompt: string;
  userPrompt: string;
  resourceCatalogIds: string[];
  missing: string[];
};

export async function draftReport(args: DraftArgs): Promise<DraftResult> {
  const { ctx, facts, patterns, weakSections, priorDraft, pinnedParagraphs, topFix } = args;
  const naming = subjectNaming(ctx);
  // Backwards-compat alias — many places in the prompt still want the
  // "primary" first name as a single token. For team cycles this is
  // the lead member's first name; the joint handle is `subjectHandle`.
  const ceoFirstName = naming.firstNames[0] ?? ctx.ceo.name.split(' ')[0];
  const subjectHandle = naming.subjectHandle;
  const subjectFullLabel = naming.subjectFullLabel;
  const teamSuffix = naming.isTeam
    ? ` (team: ${naming.teamLabel ?? '—'} · members: ${naming.firstNames.join(', ')})`
    : '';

  // Curriculum: framework rows go into the system prompt (coach voice),
  // class rows into a catalog the model picks 1–3 from.
  const rows = await db
    .select({
      id: curriculum.id,
      title: curriculum.title,
      contentText: curriculum.contentText,
      summary: curriculum.summary,
      kind: curriculum.kind,
    })
    .from(curriculum)
    .orderBy(asc(curriculum.sortOrder));
  const frameworkText = rows
    .filter((r) => r.kind === 'framework')
    .map((r) => `### ${r.title}\n${r.contentText}`)
    .join('\n\n');
  const classRows = rows.filter((r) => r.kind === 'class');
  const resourceCatalog = classRows
    .map((r) => `- id: ${r.id}\n  title: ${r.title}\n  summary: ${r.summary ?? ''}`)
    .join('\n');

  // ── System prompt: stable per coach + curriculum, suitable for caching.
  const rubricBlock = RUBRIC_ITEMS
    .map((r, i) => `${i + 1}. **${r.label}** — ${r.requirement}`)
    .join('\n');

  const systemPrompt = `You are ghostwriting the monthly coaching summary that ${ctx.coachName} sends to their ${naming.isTeam ? `coaching team ${subjectFullLabel}` : `CEO client ${ctx.ceo.name}`}. Both outputs go to ${naming.isTeam ? 'the team' : 'the CEO'} — the email lands in their inbox, the structured report is rendered as a PDF "Monthly Progress Summary" they download. Write everything as if ${subjectHandle} ${naming.isTeam ? 'are' : 'is'} reading it.

## Voice
- First-person from the coach ("I noticed", "what stood out to me"), second-person to the ${naming.isTeam ? 'team' : 'CEO'} ("you closed the COO hire", "your 10x goal"). Never third-person.
- Warm but direct. Trusted advisor, not consultant. ${subjectHandle} should think "my coach really gets ${naming.isTeam ? 'us' : 'me'}" reading this.
- Address ${subjectHandle} by first name where it lands naturally.${naming.isTeam ? `

## Team addressing
This is a coaching TEAM, not a single CEO${teamSuffix}. Adjust voice accordingly:
- Greeting and high-level reflection use the joint handle "${subjectHandle}" and second-person plural ("the two of you", "you both" for pairs / "you three" for trios / "you all"). The report is one shared document.
- Where feedback is role-specific or the inputs clearly attribute something to ONE member, address that member by first name and switch to singular for that beat: "${naming.firstNames[0]}, your Week 3 dip is the focus we talked about" — then return to plural.
- Use the team name (${naming.teamLabel ?? 'the team'}) where it lands naturally (subject line, headers, framing the company-level moves).
- Every Key Win / Challenge / Next Step that's clearly one member's domain should name that member; team-level items use the joint handle.
- The CycleFacts.evidenceClaims include attribution back to whichever member's input the claim came from. Honor that attribution.

` : ''}

## Framework Reference
${frameworkText}

## Quality bar (you will be graded on this)
The Stage D critic will score your draft against the rubric below. Solve for these explicitly — every item must hit:

${rubricBlock}

## Inputs you will receive
You will receive THREE structured blocks:
1. **CycleFacts** — typed extraction of every concrete fact in the inputs (goal cascade with drift detection, weekly effort minutes, named stakeholders, emotional events, the named constraint, evidenceClaims with sourceRefs, commitments, coachReviewFlags). **Cite these. Don't invent.**
2. **Patterns** — cross-cycle patterns (carryingForward, evolving, resolving, newThisCycle). Drives patternObservations.
3. **Raw context** — the original inputs (journals, transcript, KPIs, etc.). For grounding only — prefer Facts over re-reading raw inputs.

## Citation rule
Every keyWin and challenge must be grounded in at least one entry from facts.evidenceClaims. progressSummary must reference at least one specific number, date, or proper noun from the Facts. suggestedNextSteps each must include either a counter-factual ("2 hrs focused > 5 hrs fragmented") or a specific magnitude ("within 30 days", "$X by Y").

## Drift, emotional events, constraint stagnation → coachReviewFlags
If facts.goalCascade.driftDetected.changed is true, OR facts.emotionalEvents has entries, OR facts.constraint.movedThisCycle is false, you MUST emit at least one entry in report.coachReviewFlags with title + detail + urgency. These are visible to the coach in the UI before sending; they are NEVER shown to the CEO.

## Going Deeper
Pick 1–3 entries from the Suggested Resources catalog (sent in the user message) that genuinely fit ${subjectHandle}'s situation this cycle. Return their ids in report.suggestedResourceIds. The going_deeper email section must have one bullet per pick, in the same order, each starting with the bolded class title and 2–3 sentences in the coach's voice tying it to what ${subjectHandle} did or struggled with this cycle. Zero picks = empty arrays in both.

## Output
Return a JSON object matching this shape:

{
  // EMAIL VIEW
  "subject_line": "personal and specific, not generic",
  "opening": "1-2 paragraphs — personal greeting + high-level reflection on the cycle",
  "wins_and_progress": "What went well. Bullet points. Cite evidence claims.",
  "honest_feedback": "Where you got stuck or fell short. Kind but clear. Name the pattern if there is one.",
  "key_insight": "The ONE most important observation. 2-3 sentences max.",
  "commitments": "Numbered list of what the coach is committing to before next session, with owners + deadlines where possible.",
  "going_deeper": "Markdown bullet list, one bullet per resource picked, same order as suggestedResourceIds. Empty string if zero picks.",
  "closing": "Encouraging sign-off. Ends with the coach's name: ${ctx.coachName}",

  // STRUCTURED REPORT VIEW (PDF)
  "report": {
    "progressSummary": "1–2 paragraph snapshot, addressed to ${subjectHandle} directly. Reference the 10x goal and where ${subjectHandle} ${naming.isTeam ? 'sit' : 'sits'} relative to it.",
    "goalSummary": {
      "tenX": "stated 10x goal this cycle",
      "ninetyDay": "stated 90-day goal or null",
      "thirtyDay": "stated 30-day commitment or null",
      "flag": "one sentence flag if drift detected, else null"
    },
    "keyWins": ["You + verb — concrete win", "Win 2 …"],
    "challenges": ["Where you got stuck. Name the pattern.", "Challenge 2 …"],
    "patternObservations": "Cross-cycle patterns ONLY. Use Patterns.carryingForward / evolving / resolving. If patterns.isFirstCycle=true, say so explicitly — don't fabricate a pattern from a single data point.",
    "suggestedNextSteps": ["Verb-led commitment with counter-factual or magnitude.", "Next step 2 …"],
    "suggestedResourceIds": ["uuid", "..."],
    "coachReviewFlags": [{ "title": "...", "detail": "...", "urgency": "info|attention|urgent" }]
  }
}

The email keys and the report sections must be coherent — same wins, same challenges, same insight, two shapes. Both are addressed to ${subjectHandle} in second-person. The going_deeper bullet count must equal report.suggestedResourceIds length and use the same picks in the same order.

Return ONLY the JSON. No markdown fences, no extra text.

${FEWSHOT_BLOCK}`;

  // ── User prompt: per-cycle, NOT cached.
  const missing = listMissingInputs(ctx);
  const missingWarning = missing.length > 0
    ? `\n\n⚠️ MISSING INPUTS: ${missing.join(', ')}. Be transparent about what you don't have — don't generate vague filler.`
    : '';

  const factsBlock = `## CycleFacts (typed extraction — cite these)
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\``;

  const patternsBlock = `## Patterns (cross-cycle — drives patternObservations)
\`\`\`json
${JSON.stringify(patterns, null, 2)}
\`\`\``;

  const rawContextBlock = `## Raw context (for grounding only — prefer Facts)
${renderContextForModel(ctx)}`;

  const resourceBlock = `## Suggested Resources catalog (pick 1–3)
${resourceCatalog || '(no class catalog available)'}`;

  // Revision mode — embed prior draft and tell the model what to keep.
  let revisionBlock = '';
  if (weakSections && weakSections.length > 0 && priorDraft) {
    const sectionsList = weakSections.map((s) => `"${s}"`).join(', ');
    revisionBlock = `## REVISION MODE

You previously generated the draft below. The Stage D critic flagged these sections as weak: ${sectionsList}.

${topFix ? `**Most important fix:** ${topFix}\n\n` : ''}Rewrite ONLY those sections, keeping every other section EXACTLY as-is. Return the same full JSON shape — copy unchanged sections verbatim from the prior draft.

### Prior draft
\`\`\`json
${JSON.stringify(priorDraft, null, 2)}
\`\`\``;
  }

  let pinsBlock = '';
  if (pinnedParagraphs && pinnedParagraphs.length > 0) {
    pinsBlock = `## PINNED PARAGRAPHS (must appear verbatim)

The coach has pinned these paragraphs. They must appear verbatim in the listed sections of your output. Do not paraphrase, shorten, or merge them.

${pinnedParagraphs
  .map(
    (p, i) =>
      `### Pin ${i + 1} — section: ${p.section}\n"""\n${p.text}\n"""`,
  )
  .join('\n\n')}`;
  }

  const userPrompt = [
    factsBlock,
    patternsBlock,
    rawContextBlock,
    resourceBlock,
    revisionBlock,
    pinsBlock,
    missingWarning,
    '',
    'Write the report now. Return only the JSON.',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  // Single call with max_tokens at the model's documented ceiling
  // (see MAX_OUTPUT_TOKENS). The cap is required by the API but acts
  // as a sanity ceiling — the model stops naturally when done, so this
  // never truncates legitimate output. assertNotTruncated catches the
  // catastrophic edge case (model loop / degenerate input) loudly.
  const modelId = MODELS.reportPrimary;
  const maxTokens = MAX_OUTPUT_TOKENS[modelId];

  // Streaming + overload-retry: the SDK rejects synchronous calls when
  // max_tokens × estimated tokens-per-second exceeds 10 minutes (our
  // model-max cap always trips that threshold). `streamWithOverloadRetry`
  // wraps `.stream().finalMessage()` and retries on Anthropic
  // `overloaded_error` (HTTP 529) with exponential backoff. Same Message
  // shape comes back so the rest of this function is unchanged.
  const message = await streamWithOverloadRetry(
    {
      model: modelId,
      max_tokens: maxTokens,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    },
    'Stage C',
  );

  assertNotTruncated(message, 'Stage C', maxTokens);

  const textBlock = message.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  if (!textBlock) throw new Error('Stage C: no text response from model');

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Stage C: response was not valid JSON — ${(e as Error).message}`);
  }

  const validated = DraftedReportSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Stage C: drafted report failed schema validation — ${validated.error.message}`,
    );
  }

  return {
    drafted: stripEmDashesFromDraft(validated.data),
    modelUsed: modelId,
    systemPrompt,
    userPrompt,
    resourceCatalogIds: classRows.map((r) => r.id),
    missing,
  };
}
