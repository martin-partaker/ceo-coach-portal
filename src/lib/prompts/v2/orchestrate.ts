import 'server-only';
import { db } from '@/db';
import {
  cycleFacts as cycleFactsTable,
  reportCritiques,
  reports as reportsTable,
  type Cycle,
  type Ceo,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { fetchCycleContext } from './context';
import { extractFacts } from './extract-facts';
import { matchPatterns } from './match-patterns';
import { draftReport } from './draft';
import { critiqueReport } from './critique';
import type { DraftedReport, RefinableSection } from './schemas';
import { sanitiseSuggestedResources } from './resources';

/**
 * v2 generation orchestrator.
 *
 * Pipeline:
 *   1. Stage A — extractFacts → CycleFacts
 *   2. Stage B — matchPatterns → Patterns
 *   3. Persist {facts, patterns} to cycle_facts (upsert by cycleId)
 *   4. Stage C — draftReport → DraftedReport
 *   5. Stage D — critiqueReport → Critique
 *   6. If !pass and revisions remaining: rewrite weakSections, recheck
 *   7. Persist final draft to reports + critique to report_critiques
 *
 * Returns the persisted report row + critique + facts so the caller
 * (router/UI) can show the rubric scores and the coach review flags.
 */

const MAX_REVISIONS = 2;

export type OrchestrateArgs = {
  cycle: Cycle;
  ceo: Ceo;
  coachName: string;
};

export type OrchestrateResult = {
  reportId: string;
  contentJson: DraftedReport;
  rawText: string;
  modelUsed: string;
  factsId: string;
  critiqueId: string;
  passed: boolean;
  topFix: string | null;
  weakSections: string[];
  revisionsApplied: number;
  missing: string[];
};

export async function orchestrateGenerateV2(
  args: OrchestrateArgs,
): Promise<OrchestrateResult> {
  const ctx = await fetchCycleContext(args);

  // Stage A
  const { facts, modelUsed: factsModel } = await extractFacts(ctx);

  // Stage B
  const { patterns, modelUsed: patternsModel } = await matchPatterns({
    ctx,
    currentFacts: facts,
  });

  // Persist Facts + Patterns. Upsert by cycleId so re-running this for
  // the same cycle replaces, not duplicates.
  const factsModelLabel = `${factsModel}+${patternsModel}`;
  const [factsRow] = await db
    .insert(cycleFactsTable)
    .values({
      cycleId: args.cycle.id,
      factsJson: facts as unknown as Record<string, unknown>,
      patternsJson: patterns as unknown as Record<string, unknown>,
      modelUsed: factsModelLabel,
    })
    .onConflictDoUpdate({
      target: cycleFactsTable.cycleId,
      set: {
        factsJson: facts as unknown as Record<string, unknown>,
        patternsJson: patterns as unknown as Record<string, unknown>,
        modelUsed: factsModelLabel,
        generatedAt: new Date(),
      },
    })
    .returning();

  // Stage C — first draft
  const firstDraft = await draftReport({ ctx, facts, patterns });
  let currentDraft: DraftedReport = firstDraft.drafted;

  // Stage D — critique loop
  let critique = (await critiqueReport({ facts, patterns, draft: currentDraft })).critique;
  let revisionsApplied = 0;

  while (!critique.pass && revisionsApplied < MAX_REVISIONS) {
    const weak = critique.weakSections as RefinableSection[];
    if (weak.length === 0) break; // critic said fail but listed no sections — bail

    const revised = await draftReport({
      ctx,
      facts,
      patterns,
      weakSections: weak,
      priorDraft: currentDraft,
      topFix: critique.topFix,
    });
    currentDraft = revised.drafted;
    revisionsApplied += 1;
    critique = (await critiqueReport({ facts, patterns, draft: currentDraft })).critique;
  }

  // Validate suggestedResourceIds against the curriculum table — drop
  // unknown UUIDs the model may have invented.
  currentDraft.report.suggestedResourceIds = await sanitiseSuggestedResources(
    db,
    currentDraft.report.suggestedResourceIds,
  );

  // Compose rawText (email body) for storage + copy/paste.
  const rawText = composeEmailRawText(currentDraft);

  // Persist final report.
  const [reportRow] = await db
    .insert(reportsTable)
    .values({
      cycleId: args.cycle.id,
      contentJson: currentDraft as unknown as Record<string, unknown>,
      rawText,
      modelUsed: firstDraft.modelUsed,
      promptVersion: 3, // v2 pipeline
    })
    .returning();

  // Persist critique alongside the report for evals.
  const [critiqueRow] = await db
    .insert(reportCritiques)
    .values({
      reportId: reportRow.id,
      pass: critique.pass,
      rubricJson: critique as unknown as Record<string, unknown>,
      weakSections: critique.weakSections as unknown as Record<string, unknown>,
      modelUsed: 'critic',
    })
    .returning();

  return {
    reportId: reportRow.id,
    contentJson: currentDraft,
    rawText,
    modelUsed: firstDraft.modelUsed,
    factsId: factsRow.id,
    critiqueId: critiqueRow.id,
    passed: critique.pass,
    topFix: critique.topFix,
    weakSections: critique.weakSections,
    revisionsApplied,
    missing: firstDraft.missing,
  };
}

/** Build a copy-pasteable email body from the drafted report's email
 *  view. Mirrors v1's contentJsonToRawText so the existing UI keeps
 *  working without modification. */
export function composeEmailRawText(d: DraftedReport): string {
  const parts: string[] = [];
  if (d.opening) parts.push(d.opening);
  if (d.wins_and_progress) parts.push(d.wins_and_progress);
  if (d.honest_feedback) parts.push(d.honest_feedback);
  if (d.key_insight) parts.push(d.key_insight);
  if (d.commitments) parts.push(d.commitments);
  if (d.going_deeper && d.going_deeper.trim()) {
    parts.push(`**Going deeper this month**\n\n${d.going_deeper.trim()}`);
  }
  if (d.closing) parts.push(d.closing);
  return parts.join('\n\n');
}

/** Re-fetch a stored CycleFacts + Patterns row for downstream stages
 *  (refine-section, manual critique re-run). Returns null if not yet
 *  generated. */
export async function loadCycleFactsRow(cycleId: string) {
  const [row] = await db
    .select()
    .from(cycleFactsTable)
    .where(eq(cycleFactsTable.cycleId, cycleId))
    .limit(1);
  return row ?? null;
}
