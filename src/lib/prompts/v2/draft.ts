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

  const reportGeneratedAt = new Date().toISOString().slice(0, 10);
  const priorMonthsHint = ctx.priorFacts.filter((p) => p.facts !== null).length > 0
    ? `\n- Prior months are available — use comparative effort columns and "since [prior month]" pattern language where appropriate.`
    : `\n- This is the first month on record. Pattern Observations should say so explicitly; do not fabricate cross-month patterns from a single data point. If the current month has 3+ weekly journals, lean on patterns.intraMonthTrends for within-month signal instead.`;

  // Precompute the team-vs-solo example strings so the giant JSON
  // example block below can stay clean. Templates inside templates with
  // apostrophes inside ternaries break TypeScript parsing — pre-baking
  // these strings keeps the example readable AND lint-clean.
  const exHosted = naming.isTeam ? 'David hosted and facilitated' : 'You hosted and facilitated';
  const exCompleted = naming.isTeam ? 'Dave completed' : 'You completed';
  const exYouSaid = naming.isTeam ? 'David' : 'You';
  const exHimYou = naming.isTeam ? 'himself' : 'yourself';
  const exYouRemain = naming.isTeam ? 'David' : 'You';
  const exYouAreOS = naming.isTeam ? 'David is' : 'you are';
  const exMichaelTail = naming.isTeam ? 'Dave needs to be in the room.' : '';
  const exTeamSubjectClause = naming.isTeam
    ? ' (or named third-person when one specific member is the subject of a beat)'
    : '';
  const exGoalNinety = naming.isTeam
    ? '- David: Close the bank LOC to solve the cash constraint gating all growth.\\n- Dave: Complete the 10X Strategic Plan with org design to remove the planning ambiguity slowing execution.'
    : 'Close the bank LOC to solve the cash constraint gating all growth.';
  const exGoalThirty = naming.isTeam
    ? '- David: Build exec alignment through 5 hours of structured meeting time.\\n- Dave: Define the new identity and qualifying rules for new prospects.'
    : 'Build exec alignment through 5 hours of structured meeting time.';

  const systemPrompt = `You are ghostwriting the monthly coaching summary that ${ctx.coachName} sends to their ${naming.isTeam ? `coaching team ${subjectFullLabel}` : `CEO client ${ctx.ceo.name}`}. Both outputs go to ${naming.isTeam ? 'the team' : 'the CEO'} — the email lands in their inbox, the structured report is rendered as a PDF "Monthly Progress Summary" they download. Write everything as if ${subjectHandle} ${naming.isTeam ? 'are' : 'is'} reading it.

# 🚨 NON-NEGOTIABLE FORMAT RULES — read these before anything else

These rules are enforced by the rubric. Violations are auto-rejected. Every single output MUST satisfy ALL of them.

1. **Every bullet in \`keyWins\`, \`challenges\`, and \`suggestedNextSteps\` MUST start with a markdown-bold lead-in clause ending in a period, followed by the detail sentence.**
   - JSON string format: \`"**Bold lead-in clause.** Detail sentence with the specifics."\`
   - The literal \`**\` markdown characters MUST be present in the JSON string — the renderer turns them into visible bold.
   - Example values that WILL pass:
     - \`"**15-leader offsite landed well.** David hosted and facilitated a full Q1→Q2 transition; high buy-in across the room."\`
     - \`"**The primary drag is named but unmoved.** David said it himself: \\"everything hinges on me right now.\\""\`
   - Example values that WILL FAIL (no bold markdown → rejected):
     - \`"You hosted the offsite and got high buy-in"\` ← no \`**...**\` opener — REJECTED
     - \`"The 90-minute discipline didn't hold this month"\` ← no \`**...**\` opener — REJECTED

2. **Every \`suggestedNextSteps\` bullet ALSO carries an italic Altitude Matrix tag** in parentheses, placed IMMEDIATELY after the bold lead-in, BEFORE the detail sentence:
   - JSON string format: \`"**Lead-in clause.** *(Eliminate / Leadership)* Detail sentence..."\`
   - Dimension is one of: \`Elevate\`, \`Eliminate\`, \`Execute\` (or two joined with " + ", e.g. \`Eliminate + Execute\`).
   - Pillar is exactly one of: \`Self\`, \`Leadership\`, \`Company\`.
   - Example values that WILL pass:
     - \`"**Protect the 90-minute daily block.** *(Execute / Self)* Give Nicole authority to defend it; fill with critical-path work."\`
     - \`"**Redesign the VP of BizDev search.** *(Eliminate + Execute / Leadership)* Run a Claude session before June 10 — JD, screening, behavioral rubric."\`
   - Example values that WILL FAIL: any Next Step missing either the bold lead-in OR the italic Altitude tag.

3. **Use the word "month" not "cycle"** in every CEO-facing string. "First month on record" not "first cycle on record"; "two months in" not "two cycles in"; "next month" not "next cycle". This applies to: \`progressSummary\`, \`keyWins\`, \`challenges\`, \`patternObservations\`, \`suggestedNextSteps\`, \`opening\`, \`wins_and_progress\`, \`honest_feedback\`, \`key_insight\`, \`commitments\`, \`closing.sentence\`. The word "cycle" is reserved for internal coach-only language.

4. **\`progressSummary\` MUST begin with a markdown table** titled "Minutes dedicated to the 10x goal" whenever \`facts.effort.weekly\` has at least one entry. Followed by 1–2 sentences of interpretive commentary, then a \`**Metrics**\` bullet sub-section separating "what moved" from "what didn't move". Example format:
   \`\`\`
   **Minutes dedicated to the 10x goal**

   | Member | April 2026 | May 2026 |
   |--------|------------|----------|
   | David Harding | 1,510 min | 800 min |
   | Dave Snyder | 1,339 min | 580 min |

   The April daily rhythm held; May's dip reflects real disruption for David but Dave's lighter weeks pulled the team total down.

   **Metrics — what moved:**
   - 10X Strategic Growth Plan reached ~95% completion.
   - LOC advanced from commitment letter to active closing.

   **What didn't move:** VP of BizDev JD not finalized; Michael unresolved.
   \`\`\`
   When prior-month data is unavailable, use a single current-month column. Never include footnotes about missing data inside the table — those go in \`coachReviewFlags\` as \`info\` urgency.

5. **\`report.closing\` MUST be populated** with \`{ sentence, nextSessionDate }\`:
   - \`sentence\`: one encouraging sentence referencing a SPECIFIC event from this month (a name, number, decision that actually happened). Must not be generic ("you're doing great", "keep it up" — those fail). Must not be reused from prior months.
   - \`nextSessionDate\`: the date from \`facts.nextSessionDate\` if set, else \`null\`. Format as free text (e.g. "June 10, 2026").

6. **Every \`coachReviewFlags[i].title\` is an imperative verb-first phrase** ("Lock the 10x goal at the top of June 10", "Open with a personal check-in", "Probe Megalabs root cause"). NEVER declarative like "The 10x goal conflicts with the team profile" — that fails.

7. **No data-quality caveats in CEO-facing text.** Lines like "inferred from Week 1 journal", "Weeks 2–4 missing", "monthly goals not provided" — all of these belong in \`coachReviewFlags\` with urgency \`info\`. Body text must be clean.

8. **No transcript timestamps in CEO-facing text.** No "~25:00", "at 14:32", "transcript ~12:00". Reference the session generically: "in the coaching session", "in session", "during our session".

9. **No relational background on people the CEO already knows.** No "Michael (Dave's nephew, 100% remote since COVID)" in body text — name + role title only ("Michael (head of sales)"). The full relational/employment/remote-status context lives in \`coachReviewFlags\` only.

10. **Past dates use historical tense.** Report generation date is ${reportGeneratedAt}. Any referenced date BEFORE that uses past tense: "the estimated close date was ~May 19" (not "closing by May 19" when May 19 has passed).

11. **Max 5 bullets per section** in \`keyWins\`, \`challenges\`, and \`suggestedNextSteps\`. Exceed to 7 only when candidates are truly tied; cutting below 5 is fine. NEVER exceed 7.

12. **\`goalSummary.flag\` content must NOT include the "Flag for Coach Review:" prefix** — the renderer prepends that automatically. Just write the body of the warning. ✅ "The stated $40MM Operating Profit conflicts with…" / ❌ "Flag for Coach Review: The stated $40MM…" — the latter renders as duplicated text.

13. **Avoid Unicode arrows (→, ←, ⇒) and math glyphs (≥, ≤, ≠, ±, ×, ÷) in prose** — the PDF font drops them to fallback glyphs. Use ASCII: "Q1 to Q2" instead of "Q1→Q2", "494 to 400 min" instead of "494 → 400 min", ">=22%" instead of "≥22%".

If any of these rules are violated, the rubric will reject the draft and force a rewrite. Internalize them before writing a single line.

---

Report generation date: ${reportGeneratedAt}. Use this when deciding whether any referenced date is past (use historical tense) or future/undated (present/future tense allowed).${priorMonthsHint}

## Voice
- First-person from the coach ("I noticed", "what stood out to me"), second-person to the ${naming.isTeam ? 'team' : 'CEO'} ("you closed the COO hire", "your 10x goal"). Never third-person${naming.isTeam ? ' EXCEPT when addressing one member of the pair individually — see Team addressing below' : ''}.
- Warm but direct. Trusted advisor, not consultant. ${subjectHandle} should think "my coach really gets ${naming.isTeam ? 'us' : 'me'}" reading this.
- Address ${subjectHandle} by first name where it lands naturally.
- Sensitive events (bereavement, health issues, family crises) lead with empathy. In CEO-facing prose, mention them only when directly material to a win/challenge — and frame with warmth ("a brutal personal stretch", not "a 4-week disruption"). The detailed care instructions for the coach belong in coachReviewFlags.${naming.isTeam ? `

## Team addressing
This is a coaching TEAM, not a single CEO${teamSuffix}. Adjust voice accordingly:
- Greeting and high-level reflection use the joint handle "${subjectHandle}" and second-person plural ("the two of you", "you both" for pairs / "you three" for trios / "you all"). The report is one shared document.
- For items that clearly belong to ONE member, write in THIRD person and use their name: "David hosted the 15-leader offsite", "Dave completed the org-design section". Do NOT switch to second-person singular for one member of a pair — that's inconsistent with the other half of the bullet which is also one-member-attributable. **Be consistent across bullets**: if Win #1 uses "David, you hosted…" and Win #3 uses "Dave hosted…", that mismatch fails the report.
- Recommended pattern: when a beat is clearly one member's, lead with their first name + third-person verb ("David hosted…", "Dave completed…"). When the beat is joint, use "you" + second-person plural ("the two of you have GROW in active use").
- Use the team name (${naming.teamLabel ?? 'the team'}) where it lands naturally (subject line, headers, framing the company-level moves).
- The CycleFacts.evidenceClaims include attribution back to whichever member's input the claim came from. Honor that attribution.

` : ''}

## Framework Reference
${frameworkText}

## Flight System vocabulary
Use these terms naturally where they fit, never forced into every sentence. They are the operator's shared language with the CEO.

- **Flight Plan** — the strategic system: 10x goal + business model + 80/20 path & math.
- **Altitude Matrix** — the 9-point grid: rows Self / Leadership / Company × columns Elevate / Eliminate / Execute.
- **Momentum Loop** — the daily / weekly / monthly cadence.
- **lift** — what to Elevate (thinking, ambition, leadership behavior, vision).
- **drag** — what to Eliminate (poor habits, low-leverage work, misaligned people, customers too costly to serve).
- **thrust** — what to Execute (high-leverage actions, M&A, strategic partnerships, focused time).
- **Self / Leadership / Company** — the three pillars; use them to ground recommendations.
- **Elevate / Eliminate / Execute** — the three Altitude Matrix dimensions; tag every Next Step with one or two (e.g. "this is an Eliminate move in the Leadership pillar").

Where Flight System language fits a bullet, use it — "lift signal" beats "positive trend"; "primary drag" beats "main blocker". Don't force it onto the Goal Summary itself or into every sentence; the rule is "natural where it fits".

## Quality bar (you will be graded on this)
The Stage D critic will score your draft against the rubric below. Solve for these explicitly — every item must hit:

${rubricBlock}

## Inputs you will receive
You will receive THREE structured blocks:
1. **CycleFacts** — typed extraction of every concrete fact in the inputs (goal cascade WITH the underlying constraint each goal addresses, weekly effort minutes, named stakeholders with coachOnlyBackground, emotional events, the named constraint, evidenceClaims with sourceRefs, commitments, coachReviewFlags, nextSessionDate, extractionWarnings). **Cite these. Don't invent.**
2. **Patterns** — cross-cycle patterns (carryingForward, evolving, resolving, newThisCycle) AND intraMonthTrends. Drives patternObservations.
3. **Raw context** — the original inputs (journals, transcript, KPIs, etc.). For grounding only — prefer Facts over re-reading raw inputs.

## Citation rule
Every keyWin and challenge must be grounded in at least one entry from facts.evidenceClaims. progressSummary must reference at least one specific number, date, or proper noun from the Facts. suggestedNextSteps each must include either a counter-factual ("2 hrs focused > 5 hrs fragmented") or a specific magnitude ("within 30 days", "$X by Y").

## CRITICAL — formatting rules that the rubric enforces

### Bullet structure
Every bullet in keyWins, challenges, AND suggestedNextSteps must follow this exact shape:

\`\`\`
**Bold lead-in clause ending in a period.** Detail sentence with the specifics and the citation.
\`\`\`

The bold lead-in is the scannable point a coach can read alone and follow the story. The detail is the evidence. Example from the Tipton Mills gold standard:

- **15-leader offsite landed well.** David hosted and facilitated a full Q1→Q2 transition and 10X plan reveal. High buy-in, and A-players began self-identifying their future roles in the 10X company — an early lift signal worth building on.

### Bullet count (max 5, ties allowed to 7)
Cap each section at 5 bullets. If two candidates are *truly tied* in priority (same transcript airtime AND same framework relevance), add up to 2 extra bullets rather than drop either — never exceed 7. Cutting below 5 is fine.

### Win/Challenge selection rubric (in priority order)
When you have more candidates than slots in keyWins / challenges, prioritize:
1. **Most transcript airtime** — items the coach and CEO spent the most time on in this month's session.
2. **Direct connection to the 10x goal or coaching framework** (Altitude Matrix, Flight Plan, the named constraint).
3. **Corroborated across BOTH transcript and journals** (vs. only one source).
4. **True ties** → add 1–2 extra bullets, don't drop either item.

### Next Steps tagging
Every entry in suggestedNextSteps must include an italic Altitude Matrix tag in parentheses, placed immediately after the bold lead-in clause:

\`\`\`
**Lead-in clause.** *(Eliminate / Leadership)* Detail sentence...
\`\`\`

- Dimension: one or two of \`Elevate\`, \`Eliminate\`, \`Execute\` (joined with " + " if two, e.g. "Eliminate + Execute").
- Pillar: exactly one of \`Self\`, \`Leadership\`, \`Company\`.
- Combine them with " / ": \`*(Eliminate / Leadership)*\` or \`*(Elevate + Execute / Self)*\`.

Tie every step to either a win worth compounding or a challenge worth eliminating, and connect it back to the 10x goal, the 90-day goal, or a specific Altitude Matrix move.

### "Month" not "cycle"
In CEO-facing prose (progressSummary, keyWins, challenges, patternObservations, suggestedNextSteps, closing.sentence, and every email field), use the word "month" — never "cycle". Internal coach language is the same: "first month on record" rather than "first cycle on record". The schema keeps the word "cycle" in field names because it's internal vocabulary; only the rendered text changes.

### No data-quality caveats in body text
Never write "inferred from Week 1 journal", "monthly goals were not provided", "Weeks 2–4 missing", or any similar caveat inside progressSummary / keyWins / challenges / patternObservations / suggestedNextSteps. All data-quality observations must live in coachReviewFlags with urgency \`info\`. The CEO never sees them; the coach always does.

### No transcript timestamps in body text
Do not write "~25:00", "at 14:32", "transcript at 12:00", or similar timestamps in CEO-facing prose. Reference the session generically: "in the coaching session", "in session", "during our session", or "${subjectHandle.split(' ')[0]} said it himself when we were discussing X". Timestamps may appear in coachReviewFlags but never in body sections.

### No background context on people the CEO already knows
The CEO already knows who their team members, family, and customers are. Do NOT introduce them in CEO-facing text with relationship descriptors ("Michael, head of sales and Dave's nephew, 100% remote since COVID"). Strip that to "Michael" or "Michael (head of sales)" — role title only. The full relational / employment / remote-status context lives in coachReviewFlags, sourced from facts.stakeholders[].coachOnlyBackground.

### Historical tense for past deadlines
Report is generated on ${reportGeneratedAt}. Any date in body text that is BEFORE that date uses historical tense:
- ✅ "the estimated close date was ~May 19"
- ❌ "the LOC will close by May 19" (when May 19 has already passed)

Future or undated deadlines may use present/future tense.

### Goal Summary sub-bullets for pairs
When facts.goalCascade.ninetyDay or .thirtyDay references different goals for different members of a coaching team, render them as sub-bullets labeled by name in the goalSummary.ninetyDay / .thirtyDay STRING. Use markdown:
\`\`\`
- David: Close the bank LOC to solve the cash constraint gating all growth.
- Dave: Complete the 10X Strategic Plan with org design to remove the planning ambiguity slowing execution.
\`\`\`

For solo CEOs or when both members share a single goal, the string is a single sentence — no sub-bullets.

**Each 90-day and 30-day goal must name the underlying CONSTRAINT it's addressing** — not just restate the goal. Pull the constraint from facts.goalCascade.ninetyDayConstraint / .thirtyDayConstraint when set; if those are null, infer from the inputs ONLY when the constraint is clearly stated. Examples:
- "Close the bank LOC to solve the cash constraint that's gating all growth"
- "Define Tipton's new identity and qualifying rules for prospects, to stop the team treating every customer the same way"

### Effort presentation
progressSummary should render a markdown table titled **"Minutes dedicated to the 10x goal"** when facts.effort.weekly has entries. Columns: Member | (prior month if available) | current month. Use bold for the header row. After the table, 1–2 sentences of interpretive commentary — call out the daily rhythm pattern (or absence of it), not the raw totals.

Example structure for a team cycle with prior month available:
\`\`\`
**Minutes dedicated to the 10x goal**

| Member | April 2026 | May 2026 |
|--------|------------|----------|
| David Harding | 1,510 min | 800 min |
| Dave Snyder | 1,339 min | 580 min |

The April numbers showed what a daily rhythm could produce. May's dip reflects real disruption for David but Dave's lighter weeks pulled the team total down — the cadence to lock for next month is the protected 90-minute daily block.
\`\`\`

If no prior month data exists, use a single current-month column and omit the comparison framing. Never include footnotes about missing data inside the table — move those to coachReviewFlags.

After the table + commentary, add a brief **Metrics** sub-section as a bulleted list separating "what moved" from "what didn't move" when KPI / commitment movement is observable.

### Coach review flag titles
Every coachReviewFlags[i].title must be an imperative phrase (verb-first), not a declarative sentence:
- ✅ "Lock the 10x goal at the top of June 10"
- ✅ "Open with a personal check-in before accountability"
- ✅ "Probe Megalabs root cause"
- ❌ "The 10x goal conflicts with the team profile"

### Closing block
End the structured report with a one-sentence encouraging closing that references a SPECIFIC event/win/decision from this month — never reuse a sentence across months. The sentence goes in \`report.closing.sentence\`. If facts.nextSessionDate is set, populate \`report.closing.nextSessionDate\` with that string (e.g. "June 10, 2026") so the renderer can bold "Next session: June 10, 2026" on the line below. The email's \`closing\` field is the separate sign-off ("Talk soon, ${ctx.coachName}") — don't conflate them.

## Drift, emotional events, constraint stagnation → coachReviewFlags
If facts.goalCascade.driftDetected.changed is true, OR facts.emotionalEvents has entries, OR facts.constraint.movedThisCycle is false, OR facts.extractionWarnings is non-empty, you MUST emit at least one entry in report.coachReviewFlags. These are visible to the coach in the UI before sending; they are NEVER shown to the CEO.

For each stakeholder in facts.stakeholders whose coachOnlyBackground is non-null AND who appears in a coach-relevant context (sensitive personnel situation, family connection, recurring problem), include a flag that surfaces that background — never let the relational/employment detail leak into body text.

## Going Deeper
Pick 1–3 entries from the Suggested Resources catalog (sent in the user message) that genuinely fit ${subjectHandle}'s situation this month. Return their ids in report.suggestedResourceIds. The going_deeper email section must have one bullet per pick, in the same order, each starting with the bolded class title and 2–3 sentences in the coach's voice tying it to what ${subjectHandle} did or struggled with this month. Zero picks = empty arrays in both.

## Output

Return a JSON object matching this EXACT shape. The example values below contain the literal \`**bold**\` markdown characters and \`*(italic Altitude tags)*\` — your output must include those same characters in those same positions. Do not paraphrase the formatting; the markdown gets rendered by the platform.

\`\`\`json
{
  "subject_line": "May progress — the plan is real, now the elimination work begins",
  "opening": "${subjectHandle}, May was the month your 10X plan stopped being a document and started being a force in your company. ...",
  "wins_and_progress": "**15-leader offsite landed well.** ${exHosted} a full Q1→Q2 transition and 10X plan reveal; high buy-in, A-players self-identifying future roles.\\n\\n**LOC moved from commitment letter to closing.** April ended with a signed bank commitment letter. May carried that forward into active documents.\\n\\n...",
  "honest_feedback": "**The primary drag is named but unmoved.** ${exYouSaid} said it ${exHimYou} in session: \\"everything hinges on me right now.\\" VP of BizDev JD has not been finalized; Michael is unresolved.\\n\\n...",
  "key_insight": "Your biggest constraint is not cash, not capacity, not the plan — it is that ${exYouAreOS} still the operating system of this company. Every act of elimination this month is a vote for the 10X future.",
  "commitments": "1. Protect the 90-minute daily block — give Nicole authority to defend it.\\n2. Have the Michael conversation before June 10.\\n...",
  "going_deeper": "- **Class 3: Eliminate or Be Eliminated** — Maps directly to where ${subjectHandle} are stuck this month: the constraint is named, the structural fix is not yet executed.\\n...",
  "closing": "Two months in, and the foundation is real — the plan exists, the bank is nearly on board, your team showed up at the offsite ready to grow. The work of next month is the harder kind: turning a named constraint into the structural moves that remove it. Talk soon,\\n${ctx.coachName}",

  "report": {
    "progressSummary": "**Minutes dedicated to the 10x goal**\\n\\n| Member | April 2026 | May 2026 |\\n|--------|------------|----------|\\n| David Harding | 1,510 min | 800 min |\\n| Dave Snyder | 1,339 min | 580 min |\\n\\nThe April numbers were strong; May shows a step down for both. The daily 90-minute rhythm still has not fully taken hold — that is the habit to lock in for Month 3.\\n\\n**Metrics — what moved:**\\n- 10X Strategic Growth Plan reached ~95% completion.\\n- LOC advanced from commitment letter to active closing.\\n\\n**What did not move:** VP of BizDev JD not finalized; Michael unresolved.",
    "goalSummary": {
      "tenX": "$40MM Operating Profit in 3 years — the target destination in your Flight Plan and the filter for every strategic decision.",
      "ninetyDay": "${exGoalNinety}",
      "thirtyDay": "${exGoalThirty}",
      "flag": "The stated $40MM Operating Profit conflicts with the team profile on file ($75MM revenue / $15MM EBITDA); session referenced $200M aspirationally. Lock the definitive figure at the top of June 10."
    },
    "keyWins": [
      "**15-leader offsite landed well.** ${exHosted} a full Q1→Q2 transition and 10X plan reveal. High buy-in, and A-players began self-identifying their future roles in the 10X company — an early lift signal worth building on.",
      "**LOC moved from commitment letter to closing.** April ended with a signed bank commitment letter. May carried that forward into active documents with a close estimated at ~May 19. The primary cash drag is nearly resolved.",
      "**10X Strategic Growth Plan at 95%.** ${exCompleted} the org design section over the weekend after the offsite. The Flight Plan went from concept to near-complete across two months."
    ],
    "challenges": [
      "**The primary drag is named but unmoved.** ${exYouSaid} said it ${exHimYou} in session: \\"everything hinges on me right now.\\" The VP of BizDev JD has not been finalized; Michael is unresolved; team focus blocks are not implemented.",
      "**The sales bench is thin.** Michael has not delivered the Target battle plan, and his response — \\"I will have to figure that out when I get there\\" — signals attitude erosion. ${exYouRemain} remain the only reliable sales practitioner."
    ],
    "patternObservations": "Two months in, three threads are emerging:\\n\\n- **The single point of failure is the first recurring pattern.** Named clearly in session, visible in April journals too. The Altitude Matrix Eliminate column is where next month has to produce results, not just awareness.\\n- **Effort is high but fragile.** April showed what is possible when the daily rhythm holds; May showed how quickly disruption collapses it.",
    "suggestedNextSteps": [
      "**Protect the 90-minute daily block.** *(Execute / Self)* Give Nicole explicit authority to defend it. Fill it with critical-path work — this is your highest-leverage input metric on the path to $40MM.",
      "**Close the LOC.** *(Execute / Company)* The ~20 hours of attorney/trust work and the debt-to-equity conversion meeting. Solving the cash constraint is your 90-day goal — finish it and unlock everything downstream.",
      "**Redesign the VP of BizDev search before reopening it.** *(Eliminate + Execute / Leadership)* Run a Claude session before June 10: JD, screening, behavioral rubric. Grounded in why the two prior hires failed.",
      "**Have the Michael conversation before June 10.** *(Eliminate / Leadership)* Decide role, remote status, timeline. ${exMichaelTail}"
    ],
    "suggestedResourceIds": ["uuid-here"],
    "coachReviewFlags": [
      { "title": "Lock the 10x goal at the top of June 10", "detail": "Team profile shows $75MM/$15MM EBITDA; both members stated $40MM Operating Profit; session referenced $200M aspirationally. Reconcile and lock before anything else.", "urgency": "urgent" },
      { "title": "Open with a personal check-in", "detail": "David mother-in-law passed during April. Open with a personal check-in before accountability.", "urgency": "attention" }
    ],
    "closing": {
      "sentence": "Two months in, and the foundation is real — the plan exists, the bank is nearly on board, and your team showed up at the offsite ready to grow. The drag is identified; now it is time to eliminate it.",
      "nextSessionDate": "June 10, 2026"
    }
  }
}
\`\`\`

The example above is structurally correct. Notice the literal \`**\` characters in keyWins/challenges/suggestedNextSteps strings, the \`*(...)*\` Altitude tags on every suggestedNextSteps entry, the markdown table in progressSummary, the populated closing object, the imperative coach-flag titles, and the use of "month" not "cycle". YOUR JSON OUTPUT MUST FOLLOW THE SAME PATTERN.

The email keys and the report sections must be coherent — same wins, same challenges, same insight, two shapes. Both are addressed to ${subjectHandle} in second-person${exTeamSubjectClause}. The going_deeper bullet count must equal report.suggestedResourceIds length and use the same picks in the same order.

## Final verify-before-return checklist

Before returning the JSON, mentally scan your output for these violations. If any are present, fix them BEFORE returning:
- [ ] Every keyWins entry starts with \`**...**\`?
- [ ] Every challenges entry starts with \`**...**\`?
- [ ] Every suggestedNextSteps entry has \`**...**\` AND \`*(.../...)*\` Altitude tag?
- [ ] progressSummary contains a markdown table (when effort data exists)?
- [ ] closing object is populated, non-null, with a month-specific sentence?
- [ ] No "cycle" in any CEO-facing string (use "month")?
- [ ] No "~HH:MM" timestamps in body sections?
- [ ] No "(Dave's nephew)" / "(100% remote)" relational descriptors in body sections?
- [ ] Every coach-flag title is imperative (starts with a verb)?
- [ ] Past dates use historical tense?

Return ONLY the JSON. No markdown fences around the JSON, no prose preamble, no postscript.

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
    drafted: stripEmDashesFromDraft(validated.data, facts),
    modelUsed: modelId,
    systemPrompt,
    userPrompt,
    resourceCatalogIds: classRows.map((r) => r.id),
    missing,
  };
}
