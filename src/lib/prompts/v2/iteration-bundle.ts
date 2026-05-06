import 'server-only';
import { db } from '@/db';
import {
  ceos,
  coaches,
  cycleFacts as cycleFactsTable,
  cycles,
  reportCritiques,
  reports as reportsTable,
} from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { fetchCycleContext, renderContextForModel, listMissingInputs } from './context';
import type {
  CycleFacts,
  Patterns,
  Critique,
  DraftedReport,
} from './schemas';
import { buildPrompt as buildV1Prompt } from '@/lib/prompts/builder';

/**
 * v2 "break out to LLM" bundle.
 *
 * Mirrors v1's previewPrompt but loaded with everything the v2 pipeline
 * produced (typed CycleFacts, Patterns, the rubric Critique, and the
 * polished report) so a coach can paste the bundle into any off-platform
 * LLM and iterate on the result without losing context.
 *
 * The "iteration prompt" is the load-bearing artifact — a single
 * self-contained markdown document the coach can copy into Claude.ai /
 * ChatGPT / Gemini and have a productive iteration session about the
 * generated report.
 */

export type V2IterationBundle = {
  ceoName: string;
  cycleLabel: string;
  coachName: string;
  periodStart: string | null;
  periodEnd: string | null;
  finalReport: DraftedReport | null;
  reportGeneratedAt: string | null;
  facts: CycleFacts | null;
  patterns: Patterns | null;
  critique: Critique | null;
  rawContext: string;
  contextFiles: Array<{ path: string; content: string }>;
  iterationPrompt: string;
  missing: string[];
};

export async function buildV2IterationBundle({
  cycleId,
}: {
  cycleId: string;
}): Promise<V2IterationBundle> {
  const [cycle] = await db.select().from(cycles).where(eq(cycles.id, cycleId)).limit(1);
  if (!cycle) throw new Error('Cycle not found');

  const [ceo] = await db.select().from(ceos).where(eq(ceos.id, cycle.ceoId)).limit(1);
  if (!ceo) throw new Error('CEO not found');

  const [assignedCoach] = ceo.coachId
    ? await db.select().from(coaches).where(eq(coaches.id, ceo.coachId)).limit(1)
    : [];
  const coachName = assignedCoach?.name ?? '(coach)';

  // Latest v2 report.
  const allReports = await db
    .select()
    .from(reportsTable)
    .where(eq(reportsTable.cycleId, cycleId))
    .orderBy(desc(reportsTable.generatedAt));
  const v2Row = allReports.find((r) => r.promptVersion >= 3) ?? null;
  const finalReport = (v2Row?.contentJson ?? null) as DraftedReport | null;

  // Facts + Patterns.
  const [factsRow] = await db
    .select()
    .from(cycleFactsTable)
    .where(eq(cycleFactsTable.cycleId, cycleId))
    .limit(1);
  const facts = (factsRow?.factsJson ?? null) as CycleFacts | null;
  const patterns = (factsRow?.patternsJson ?? null) as Patterns | null;

  // Latest critique attached to the v2 report.
  let critique: Critique | null = null;
  if (v2Row) {
    const [critiqueRow] = await db
      .select()
      .from(reportCritiques)
      .where(eq(reportCritiques.reportId, v2Row.id))
      .orderBy(desc(reportCritiques.generatedAt))
      .limit(1);
    if (critiqueRow) {
      critique = critiqueRow.rubricJson as Critique;
    }
  }

  // Reuse the v1 builder's contextFiles bundle — same raw inputs.
  const v1Bundle = await buildV1Prompt({
    cycle,
    ceo,
    coachName,
    previousReports: [],
  });
  const contextFiles = v1Bundle.contextFiles;

  // Render the rich context once for inlining into the iteration prompt.
  const ctx = await fetchCycleContext({ cycle, ceo, coachName });
  const rawContext = renderContextForModel(ctx);
  const missing = listMissingInputs(ctx);

  const iterationPrompt = buildIterationPrompt({
    ceoName: ceo.name,
    cycleLabel: cycle.label,
    coachName,
    finalReport,
    facts,
    patterns,
    critique,
    rawContext,
    missing,
  });

  return {
    ceoName: ceo.name,
    cycleLabel: cycle.label,
    coachName,
    periodStart: cycle.periodStart,
    periodEnd: cycle.periodEnd,
    finalReport,
    reportGeneratedAt: v2Row?.generatedAt?.toISOString() ?? null,
    facts,
    patterns,
    critique,
    rawContext,
    contextFiles,
    iterationPrompt,
    missing,
  };
}

/**
 * Build the self-contained "let's iterate" prompt. Goal: paste this
 * into Claude.ai / ChatGPT / Gemini and the LLM has everything it
 * needs to refine the report intelligently.
 */
function buildIterationPrompt(args: {
  ceoName: string;
  cycleLabel: string;
  coachName: string;
  finalReport: DraftedReport | null;
  facts: CycleFacts | null;
  patterns: Patterns | null;
  critique: Critique | null;
  rawContext: string;
  missing: string[];
}): string {
  const {
    ceoName,
    cycleLabel,
    coachName,
    finalReport,
    facts,
    patterns,
    critique,
    rawContext,
    missing,
  } = args;

  const reportMarkdown = finalReport
    ? renderReportAsMarkdown(finalReport)
    : '*(no v2 report has been generated yet for this cycle — you can use the raw context below to draft one from scratch)*';

  const factsBlock = facts
    ? `\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``
    : '*(not yet extracted)*';
  const patternsBlock = patterns
    ? `\`\`\`json\n${JSON.stringify(patterns, null, 2)}\n\`\`\``
    : '*(not yet computed)*';
  const critiqueBlock = critique
    ? `\`\`\`json\n${JSON.stringify(critique, null, 2)}\n\`\`\``
    : '*(no critique on file)*';

  const missingWarning = missing.length > 0
    ? `\n\n> ⚠️ Missing inputs flagged at generation time: **${missing.join(', ')}**. Be transparent about gaps if I ask you to add detail in those areas.`
    : '';

  return `# Iterate on this monthly coaching report

You are **${coachName}**, an executive coach. You wrote a monthly progress summary for your CEO client **${ceoName}** for the cycle **${cycleLabel}**. We generated this report through a multi-stage pipeline (typed-fact extraction → cross-cycle pattern matching → drafting → rubric-checked revision). Below is everything that pipeline produced, plus the original raw inputs.

I want you to help me iterate on the report. I'll tell you what to change. Maintain the warm-but-direct coaching voice, address ${ceoName} in second-person ("you"), and **never invent facts** — every claim has to be grounded in the CycleFacts or the raw context. If my refinement request would force you to invent something not in the data, push back and tell me what's missing.

---

## 1. The current report (final, polished)

${reportMarkdown}

---

## 2. CycleFacts — the typed extraction

This is the structured fact layer the report was grounded in. Every win, challenge, and metric in the report should map to one of these claims with its sourceRef.

${factsBlock}

---

## 3. Patterns — cross-cycle observations

How this cycle compares to prior ones (carrying-forward, evolving, resolving, new).

${patternsBlock}

---

## 4. Critique — how the report scored against the rubric

Our 9-row rubric and the critic's verdict on whether the report cleared each row, plus the most important fix to apply.

${critiqueBlock}

---

## 5. Raw context — the original inputs

Journals, transcript, KPIs, monthly reflection, prior reports — everything the pipeline started from.

${rawContext}${missingWarning}

---

## How to help me

When I send a refinement request:
1. Apply the change to the report above.
2. Cite which CycleFacts evidence claim(s) you're leaning on. If a claim isn't in the facts, refuse to add it and tell me it's missing.
3. Preserve the report's structure (Goal Summary → Progress Summary → Key Wins → Challenges → Pattern Observations → Recommended Next Steps) unless I explicitly ask for restructuring.
4. Keep the coaching voice consistent: warm, direct, second-person to ${ceoName.split(' ')[0]}, named-concept anchors where they fit naturally (10x goal, constraint, say/do gap, momentum).
5. When you return a revised section, return the FULL updated section so I can paste it back into our system.

Ready when you are. What should change?
`;
}

/** Render a DraftedReport as a clean markdown document. Mirrors the
 *  in-app PDF-style view so the LLM sees the report the same way the
 *  coach does. */
function renderReportAsMarkdown(d: DraftedReport): string {
  const r = d.report;
  const parts: string[] = [];

  if (r.goalSummary) {
    parts.push('### 1. Goal Summary');
    if (r.goalSummary.tenX) parts.push(`- **10x Goal:** ${r.goalSummary.tenX}`);
    if (r.goalSummary.ninetyDay) parts.push(`- **90-Day Goal:** ${r.goalSummary.ninetyDay}`);
    if (r.goalSummary.thirtyDay) parts.push(`- **30-Day Goal:** ${r.goalSummary.thirtyDay}`);
    if (r.goalSummary.flag) parts.push(`\n> ⚑ **Flag for Coach Review:** ${r.goalSummary.flag}`);
    parts.push('');
  }

  if (r.progressSummary) {
    parts.push('### 2. Progress Summary');
    parts.push(r.progressSummary);
    parts.push('');
  }

  if (r.keyWins && r.keyWins.length > 0) {
    parts.push('### 3. Key Wins');
    for (const w of r.keyWins) parts.push(`- ${w}`);
    parts.push('');
  }

  if (r.challenges && r.challenges.length > 0) {
    parts.push('### 4. Challenges & Patterns');
    for (const c of r.challenges) parts.push(`- ${c}`);
    parts.push('');
  }

  if (r.patternObservations) {
    parts.push('### 5. Pattern Observations');
    parts.push(r.patternObservations);
    parts.push('');
  }

  if (r.suggestedNextSteps && r.suggestedNextSteps.length > 0) {
    parts.push('### 6. Recommended Next Steps');
    r.suggestedNextSteps.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
    parts.push('');
  }

  if (r.coachReviewFlags && r.coachReviewFlags.length > 0) {
    parts.push('### Coach review flags (visible to coach only — not sent to CEO)');
    for (const f of r.coachReviewFlags) {
      parts.push(`- **[${(f.urgency ?? 'attention').toUpperCase()}] ${f.title}** — ${f.detail}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
