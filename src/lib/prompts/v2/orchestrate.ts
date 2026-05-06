import 'server-only';
import { db } from '@/db';
import {
  cycleFacts as cycleFactsTable,
  reportCritiques,
  reportGenerationJobs,
  reports as reportsTable,
  type Cycle,
  type Ceo,
  type ReportGenerationJobStatus,
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
 * Async, job-tracked. The pipeline writes status updates to
 * `report_generation_jobs` at each stage transition so the UI can
 * render a live progress bar (and a global toast pill when the modal
 * is closed). The first-draft JSON is persisted BEFORE any revisions
 * so the UI can show a section-level diff between first→revised.
 *
 * Pipeline:
 *   1. Stage A — extractFacts → CycleFacts            (status: extracting_facts)
 *   2. Stage B — matchPatterns → Patterns              (status: matching_patterns)
 *   3. Persist {facts, patterns} to cycle_facts
 *   4. Stage C — draftReport → first DraftedReport     (status: drafting_first)
 *      → persist firstDraftJson on the job row
 *   5. Stage D — critiqueReport → Critique             (status: critiquing)
 *   6. While !pass and revisions remaining:            (status: revising)
 *      - rewrite weakSections, recheck
 *   7. Persist final draft + critique                  (status: finalising)
 *   8. Mark job complete, attach finalReportId         (status: complete)
 */

const MAX_REVISIONS = 2;

export type OrchestrateArgs = {
  jobId: string;
  cycle: Cycle;
  ceo: Ceo;
  coachName: string;
};

export type OrchestrateResult = {
  jobId: string;
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

async function updateJob(
  jobId: string,
  patch: Partial<{
    status: ReportGenerationJobStatus;
    stageDetail: unknown;
    firstDraftJson: unknown;
    finalReportId: string | null;
    critiqueId: string | null;
    revisionsApplied: number;
    error: string | null;
    completedAt: Date | null;
  }>,
) {
  await db
    .update(reportGenerationJobs)
    .set({
      ...patch,
      stageDetail:
        patch.stageDetail !== undefined
          ? (patch.stageDetail as Record<string, unknown>)
          : undefined,
      firstDraftJson:
        patch.firstDraftJson !== undefined
          ? (patch.firstDraftJson as Record<string, unknown>)
          : undefined,
      updatedAt: new Date(),
    })
    .where(eq(reportGenerationJobs.id, jobId));
}

/** Create a new job row in the `pending` state and return its id. The
 *  caller is expected to await `runGenerationJob({ jobId, ... })` in a
 *  detached promise (or via Vercel `after()`) so the mutation can
 *  return the jobId immediately for client polling. */
export async function createGenerationJob(cycleId: string): Promise<string> {
  const [row] = await db
    .insert(reportGenerationJobs)
    .values({ cycleId, status: 'pending' })
    .returning({ id: reportGenerationJobs.id });
  return row.id;
}

/** Run the full pipeline against an already-created job row. Updates
 *  status as it goes; on error, status='error' and `error` populated. */
export async function runGenerationJob(args: OrchestrateArgs): Promise<OrchestrateResult> {
  const { jobId } = args;

  try {
    const ctx = await fetchCycleContext(args);

    // Stage A
    await updateJob(jobId, {
      status: 'extracting_facts',
      stageDetail: { stage: 'extracting_facts' },
    });
    const { facts, modelUsed: factsModel } = await extractFacts(ctx);

    // Stage B
    await updateJob(jobId, {
      status: 'matching_patterns',
      stageDetail: { stage: 'matching_patterns', isFirstCycle: ctx.isFirstCycle },
    });
    const { patterns, modelUsed: patternsModel } = await matchPatterns({
      ctx,
      currentFacts: facts,
    });

    // Persist Facts + Patterns (upsert by cycleId).
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
    await updateJob(jobId, {
      status: 'drafting_first',
      stageDetail: { stage: 'drafting_first' },
    });
    const firstDraft = await draftReport({ ctx, facts, patterns });
    let currentDraft: DraftedReport = firstDraft.drafted;

    // Persist the FIRST draft on the job before any revisions so the UI
    // can later diff first → revised. We snapshot before sanitising
    // resourceIds so the diff is purely about textual revisions.
    await updateJob(jobId, {
      firstDraftJson: currentDraft as unknown,
    });

    // Stage D — critique loop
    await updateJob(jobId, {
      status: 'critiquing',
      stageDetail: { stage: 'critiquing', revision: 0 },
    });
    let critique = (
      await critiqueReport({ facts, patterns, draft: currentDraft })
    ).critique;
    let revisionsApplied = 0;

    while (!critique.pass && revisionsApplied < MAX_REVISIONS) {
      const weak = critique.weakSections as RefinableSection[];
      if (weak.length === 0) break;

      await updateJob(jobId, {
        status: 'revising',
        stageDetail: {
          stage: 'revising',
          revision: revisionsApplied + 1,
          weakSections: weak,
          topFix: critique.topFix,
        },
        revisionsApplied: revisionsApplied + 1,
      });

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

      await updateJob(jobId, {
        status: 'critiquing',
        stageDetail: { stage: 'critiquing', revision: revisionsApplied },
      });
      critique = (
        await critiqueReport({ facts, patterns, draft: currentDraft })
      ).critique;
    }

    await updateJob(jobId, {
      status: 'finalising',
      stageDetail: { stage: 'finalising' },
    });

    // Validate suggestedResourceIds.
    currentDraft.report.suggestedResourceIds = await sanitiseSuggestedResources(
      db,
      currentDraft.report.suggestedResourceIds,
    );

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

    await updateJob(jobId, {
      status: 'complete',
      stageDetail: {
        stage: 'complete',
        passed: critique.pass,
        revisions: revisionsApplied,
      },
      finalReportId: reportRow.id,
      critiqueId: critiqueRow.id,
      revisionsApplied,
      completedAt: new Date(),
    });

    return {
      jobId,
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
  } catch (e) {
    const errMsg = (e as Error).message ?? String(e);
    await updateJob(jobId, {
      status: 'error',
      stageDetail: { error: errMsg },
      error: errMsg,
      completedAt: new Date(),
    });
    throw e;
  }
}

/** Build a copy-pasteable email body from the drafted report's email
 *  view. */
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

export async function loadCycleFactsRow(cycleId: string) {
  const [row] = await db
    .select()
    .from(cycleFactsTable)
    .where(eq(cycleFactsTable.cycleId, cycleId))
    .limit(1);
  return row ?? null;
}
