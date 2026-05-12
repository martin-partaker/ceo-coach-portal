/**
 * v2 report generation as a Vercel Workflow.
 *
 * Why this is a workflow (and not just an async fn behind `after()`):
 *   - Each `"use step"` runs in its own function invocation with its own
 *     ~300s budget. The pipeline can therefore comfortably exceed the
 *     Vercel maxDuration cap without anyone fighting it.
 *   - Steps are checkpointed. If Stage C dies (timeout, deploy mid-run,
 *     network hiccup), the workflow resumes at Stage C on the next worker
 *     invocation — Stage A + B don't re-run.
 *   - Steps with non-FatalError throws are auto-retried by the runtime.
 *   - We can cancel a runaway run via `getRun(runId).cancel()` from the
 *     UI, instead of just flipping a DB row and praying.
 *
 * The workflow function is pure orchestration (`"use workflow"`).
 * Anything that touches the DB, Anthropic, or Node modules lives in a
 * step. Steps return small, serializable JSON; the workflow function
 * passes that JSON between them.
 *
 * The existing `report_generation_jobs` row is the source of truth for
 * the UI — every stage writes to it via the `setJobStatusStep` helper,
 * so the polling progress bar keeps working unchanged.
 */
import { db } from '@/db';
import { and, eq, sql } from 'drizzle-orm';
import {
  cycles,
  ceos,
  reports as reportsTable,
  reportCritiques,
  reportGenerationJobs,
  cycleFacts as cycleFactsTable,
} from '@/db/schema';
import { fetchCycleContext } from '@/lib/prompts/v2/context';
import { extractFacts } from '@/lib/prompts/v2/extract-facts';
import { matchPatterns } from '@/lib/prompts/v2/match-patterns';
import { draftReport } from '@/lib/prompts/v2/draft';
import { critiqueReport } from '@/lib/prompts/v2/critique';
import { runInstantDraft } from '@/lib/prompts/v2/instant';
import { sanitiseSuggestedResources } from '@/lib/prompts/v2/resources';
import {
  composeEmailRawText,
  tryLoadCachedFacts,
} from '@/lib/prompts/v2/orchestrate';
import type {
  CycleFacts,
  Patterns,
  DraftedReport,
  RefinableSection,
} from '@/lib/prompts/v2/schemas';

const MAX_REVISIONS = 2;

export type GenerationMode = 'instant' | 'quick' | 'full';

export interface GenerateReportWorkflowArgs {
  jobId: string;
  cycleId: string;
  /** Coach name for the document header. Plumbed through args (not
   *  loaded from DB) because the calling user may be impersonating. */
  coachName: string;
  forceRefreshFacts: boolean;
  mode: GenerationMode;
}

// ─────────────────────────────────────────────────────────────────────
// Steps — every unit of work that touches DB or external APIs.
// Each step runs in its own function invocation with its own timeout
// budget. Returning `void` is fine; returning structured JSON is fine.
// Class instances and functions are NOT serializable across step
// boundaries.
// ─────────────────────────────────────────────────────────────────────

/** Patch a job row. Used at every stage transition so the UI's progress
 *  bar reflects what's running. Idempotent — safe to retry. */
async function setJobStatusStep(
  jobId: string,
  patch: {
    status?: string;
    stageDetail?: Record<string, unknown> | null;
    finalReportId?: string | null;
    critiqueId?: string | null;
    revisionsApplied?: number;
    error?: string | null;
    completedAt?: Date | null;
  },
): Promise<void> {
  'use step';
  // CRITICAL: don't overwrite a job that has already been terminated
  // (typically by `cancelGeneration`). Without this guard, the workflow
  // happily continues running its remaining steps and each step's call
  // here would clobber the user's cancellation with the next stage's
  // status. From the user's POV: clicking Cancel "didn't work" because
  // the GeneratingScreen flickered back on within a couple of seconds.
  //
  // We treat `completedAt IS NOT NULL` as the terminal flag — both
  // normal completion and user cancellation set it. The narrow
  // exception: the workflow's OWN final write that sets completedAt
  // for the first time. Drizzle WHERE always evaluates against the
  // *current* row, so an UPDATE that sets completedAt on a row whose
  // completedAt is still NULL passes the guard. If two writers race
  // (cancel vs. workflow finalise), the first one wins — which is the
  // behaviour we want.
  await db
    .update(reportGenerationJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(reportGenerationJobs.id, jobId),
        sql`${reportGenerationJobs.completedAt} IS NULL`,
      ),
    );
}

interface CycleAndCeo {
  cycle: typeof cycles.$inferSelect;
  ceo: typeof ceos.$inferSelect;
}

/** Stage A: structured fact extraction with citations. Returns the
 *  parsed CycleFacts JSON; the workflow passes it to subsequent steps.
 *  ~30–80s on Sonnet. */
async function runStageAStep(args: {
  cycleId: string;
  coachName: string;
}): Promise<{ facts: CycleFacts; modelUsed: string }> {
  'use step';
  const { cycle, ceo } = await loadCycleAndCeoInline(args.cycleId);
  const ctx = await fetchCycleContext({ cycle, ceo, coachName: args.coachName });
  const result = await extractFacts(ctx);
  return { facts: result.facts, modelUsed: result.modelUsed };
}

/** Stage B: pattern-matching across prior cycles. Reads the current
 *  cycle's just-extracted facts (passed in as JSON) plus prior cycles'
 *  facts from cycle_facts. */
async function runStageBStep(args: {
  cycleId: string;
  coachName: string;
  facts: CycleFacts;
}): Promise<{ patterns: Patterns; modelUsed: string }> {
  'use step';
  const { cycle, ceo } = await loadCycleAndCeoInline(args.cycleId);
  const ctx = await fetchCycleContext({ cycle, ceo, coachName: args.coachName });
  const result = await matchPatterns({ ctx, currentFacts: args.facts });
  return { patterns: result.patterns, modelUsed: result.modelUsed };
}

/** Persist Stages A + B results to cycle_facts (upsert by cycleId).
 *  Returns the row id so downstream steps / API responses can
 *  correlate. */
async function persistFactsStep(args: {
  cycleId: string;
  facts: CycleFacts;
  patterns: Patterns;
  modelUsedLabel: string;
}): Promise<{ factsId: string }> {
  'use step';
  const [inserted] = await db
    .insert(cycleFactsTable)
    .values({
      cycleId: args.cycleId,
      factsJson: args.facts as unknown as Record<string, unknown>,
      patternsJson: args.patterns as unknown as Record<string, unknown>,
      modelUsed: args.modelUsedLabel,
    })
    .onConflictDoUpdate({
      target: cycleFactsTable.cycleId,
      set: {
        factsJson: args.facts as unknown as Record<string, unknown>,
        patternsJson: args.patterns as unknown as Record<string, unknown>,
        modelUsed: args.modelUsedLabel,
        generatedAt: new Date(),
      },
    })
    .returning();
  return { factsId: inserted.id };
}

/** Try to load cached facts + patterns. Returns null on miss / schema
 *  drift / partial cache so the workflow falls through to A + B. */
async function loadCachedFactsStep(cycleId: string): Promise<{
  facts: CycleFacts;
  patterns: Patterns;
  factsRowId: string;
} | null> {
  'use step';
  return await tryLoadCachedFacts(cycleId);
}

/** Stage C: prose drafting. Returns the parsed DraftedReport. Used both
 *  for the first draft and for the per-revision rewrite (with
 *  weakSections + topFix). Opus, ~60–120s. */
async function runStageCStep(args: {
  cycleId: string;
  coachName: string;
  facts: CycleFacts;
  patterns: Patterns;
  weakSections?: RefinableSection[];
  priorDraft?: DraftedReport;
  topFix?: string | null;
}): Promise<{ drafted: DraftedReport; modelUsed: string }> {
  'use step';
  const { cycle, ceo } = await loadCycleAndCeoInline(args.cycleId);
  const ctx = await fetchCycleContext({ cycle, ceo, coachName: args.coachName });
  const result = await draftReport({
    ctx,
    facts: args.facts,
    patterns: args.patterns,
    weakSections: args.weakSections,
    priorDraft: args.priorDraft,
    topFix: args.topFix ?? null,
  });
  return { drafted: result.drafted, modelUsed: result.modelUsed };
}

/** Stage D: rubric critique. Returns the critique JSON.
 *  Sonnet, ~20–30s. */
async function runStageDStep(args: {
  facts: CycleFacts;
  patterns: Patterns;
  draft: DraftedReport;
}): Promise<{
  critique: Awaited<ReturnType<typeof critiqueReport>>['critique'];
}> {
  'use step';
  const r = await critiqueReport({
    facts: args.facts,
    patterns: args.patterns,
    draft: args.draft,
  });
  return { critique: r.critique };
}

/** Instant mode: legacy single-shot generator. No facts, no critique. */
async function runInstantStep(args: {
  cycleId: string;
  coachName: string;
}): Promise<{ drafted: DraftedReport; modelUsed: string }> {
  'use step';
  const { cycle, ceo } = await loadCycleAndCeoInline(args.cycleId);
  const ctx = await fetchCycleContext({ cycle, ceo, coachName: args.coachName });
  const r = await runInstantDraft(ctx);
  return { drafted: r.drafted, modelUsed: r.modelUsed };
}

interface PersistFinalArgs {
  cycleId: string;
  draft: DraftedReport;
  modelUsed: string;
  promptVersion: number;
  /** Which mode produced this report — persisted on the row for QA /
   *  cost analytics without having to join through generation_jobs. */
  generationMode: 'instant' | 'quick' | 'full';
  // Critique row to persist alongside the report. Null in quick/instant.
  critique: Awaited<ReturnType<typeof critiqueReport>>['critique'] | null;
}

async function persistFinalReportStep(args: PersistFinalArgs): Promise<{
  reportId: string;
  critiqueId: string | null;
}> {
  'use step';
  // Sanitise suggestedResourceIds — the model occasionally invents UUIDs.
  args.draft.report.suggestedResourceIds = await sanitiseSuggestedResources(
    db,
    args.draft.report.suggestedResourceIds,
  );

  const rawText = composeEmailRawText(args.draft);

  const [reportRow] = await db
    .insert(reportsTable)
    .values({
      cycleId: args.cycleId,
      contentJson: args.draft as unknown as Record<string, unknown>,
      rawText,
      modelUsed: args.modelUsed,
      promptVersion: args.promptVersion,
      generationMode: args.generationMode,
    })
    .returning();

  let critiqueId: string | null = null;
  if (args.critique) {
    const [critiqueRow] = await db
      .insert(reportCritiques)
      .values({
        reportId: reportRow.id,
        pass: args.critique.pass,
        rubricJson: args.critique as unknown as Record<string, unknown>,
        weakSections: args.critique.weakSections as unknown as Record<string, unknown>,
        modelUsed: 'critic',
      })
      .returning();
    critiqueId = critiqueRow.id;
  }

  return { reportId: reportRow.id, critiqueId };
}

// ─────────────────────────────────────────────────────────────────────
// Workflow — pure orchestration. No DB / Anthropic / Node calls.
// ─────────────────────────────────────────────────────────────────────

export async function generateReportWorkflow(
  args: GenerateReportWorkflowArgs,
): Promise<{
  jobId: string;
  reportId: string;
  passed: boolean;
  revisionsApplied: number;
}> {
  'use workflow';

  try {
    // ── INSTANT MODE ─────────────────────────────────────────────────
    // Mode lives on the `report_generation_jobs.mode` column now, so
    // stageDetail just carries the live stage label.
    if (args.mode === 'instant') {
      await setJobStatusStep(args.jobId, {
        status: 'drafting_first',
        stageDetail: { stage: 'drafting_first' },
      });
      const instant = await runInstantStep({
        cycleId: args.cycleId,
        coachName: args.coachName,
      });
      await setJobStatusStep(args.jobId, {
        status: 'finalising',
        stageDetail: { stage: 'finalising' },
      });
      const persisted = await persistFinalReportStep({
        cycleId: args.cycleId,
        draft: instant.drafted,
        modelUsed: instant.modelUsed,
        promptVersion: 3,
        generationMode: 'instant',
        critique: null,
      });
      await setJobStatusStep(args.jobId, {
        status: 'complete',
        stageDetail: { stage: 'complete', passed: null, revisions: 0 },
        finalReportId: persisted.reportId,
        critiqueId: null,
        revisionsApplied: 0,
        completedAt: new Date(),
      });
      return {
        jobId: args.jobId,
        reportId: persisted.reportId,
        passed: true,
        revisionsApplied: 0,
      };
    }

    // ── STAGES A + B (or reuse cache) ────────────────────────────────
    let facts: CycleFacts;
    let patterns: Patterns;
    const cached = args.forceRefreshFacts
      ? null
      : await loadCachedFactsStep(args.cycleId);

    if (cached) {
      facts = cached.facts;
      patterns = cached.patterns;
      await setJobStatusStep(args.jobId, {
        status: 'extracting_facts',
        stageDetail: { stage: 'extracting_facts', reused: true },
      });
      await setJobStatusStep(args.jobId, {
        status: 'matching_patterns',
        stageDetail: { stage: 'matching_patterns', reused: true },
      });
    } else {
      await setJobStatusStep(args.jobId, {
        status: 'extracting_facts',
        stageDetail: { stage: 'extracting_facts' },
      });
      const a = await runStageAStep({
        cycleId: args.cycleId,
        coachName: args.coachName,
      });

      await setJobStatusStep(args.jobId, {
        status: 'matching_patterns',
        stageDetail: { stage: 'matching_patterns' },
      });
      const b = await runStageBStep({
        cycleId: args.cycleId,
        coachName: args.coachName,
        facts: a.facts,
      });

      await persistFactsStep({
        cycleId: args.cycleId,
        facts: a.facts,
        patterns: b.patterns,
        modelUsedLabel: `${a.modelUsed}+${b.modelUsed}`,
      });
      facts = a.facts;
      patterns = b.patterns;
    }

    // ── STAGE C — first draft ────────────────────────────────────────
    await setJobStatusStep(args.jobId, {
      status: 'drafting_first',
      stageDetail: { stage: 'drafting_first' },
    });
    const firstDraft = await runStageCStep({
      cycleId: args.cycleId,
      coachName: args.coachName,
      facts,
      patterns,
    });
    let currentDraft: DraftedReport = firstDraft.drafted;

    // ── QUICK MODE — skip critique + revisions ───────────────────────
    if (args.mode === 'quick') {
      await setJobStatusStep(args.jobId, {
        status: 'finalising',
        stageDetail: { stage: 'finalising' },
      });
      const persisted = await persistFinalReportStep({
        cycleId: args.cycleId,
        draft: currentDraft,
        modelUsed: firstDraft.modelUsed,
        promptVersion: 3,
        generationMode: 'quick',
        critique: null,
      });
      await setJobStatusStep(args.jobId, {
        status: 'complete',
        stageDetail: { stage: 'complete', passed: null, revisions: 0 },
        finalReportId: persisted.reportId,
        critiqueId: null,
        revisionsApplied: 0,
        completedAt: new Date(),
      });
      return {
        jobId: args.jobId,
        reportId: persisted.reportId,
        passed: true,
        revisionsApplied: 0,
      };
    }

    // ── STAGES D + E — critique + revision loop (full mode) ──────────
    await setJobStatusStep(args.jobId, {
      status: 'critiquing',
      stageDetail: { stage: 'critiquing', revision: 0 },
    });
    let { critique } = await runStageDStep({ facts, patterns, draft: currentDraft });
    let revisionsApplied = 0;

    while (!critique.pass && revisionsApplied < MAX_REVISIONS) {
      const weak = critique.weakSections as RefinableSection[];
      if (weak.length === 0) break;

      await setJobStatusStep(args.jobId, {
        status: 'revising',
        stageDetail: {
          stage: 'revising',
          revision: revisionsApplied + 1,
          weakSections: weak,
          topFix: critique.topFix,
        },
        revisionsApplied: revisionsApplied + 1,
      });

      const revised = await runStageCStep({
        cycleId: args.cycleId,
        coachName: args.coachName,
        facts,
        patterns,
        weakSections: weak,
        priorDraft: currentDraft,
        topFix: critique.topFix,
      });
      currentDraft = revised.drafted;
      revisionsApplied += 1;

      await setJobStatusStep(args.jobId, {
        status: 'critiquing',
        stageDetail: { stage: 'critiquing', revision: revisionsApplied },
      });
      const next = await runStageDStep({ facts, patterns, draft: currentDraft });
      critique = next.critique;
    }

    // ── FINALISE ─────────────────────────────────────────────────────
    await setJobStatusStep(args.jobId, {
      status: 'finalising',
      stageDetail: { stage: 'finalising' },
    });
    const persisted = await persistFinalReportStep({
      cycleId: args.cycleId,
      draft: currentDraft,
      modelUsed: firstDraft.modelUsed,
      promptVersion: 3,
      generationMode: 'full',
      critique,
    });
    await setJobStatusStep(args.jobId, {
      status: 'complete',
      stageDetail: {
        stage: 'complete',
        passed: critique.pass,
        revisions: revisionsApplied,
      },
      finalReportId: persisted.reportId,
      critiqueId: persisted.critiqueId,
      revisionsApplied,
      completedAt: new Date(),
    });

    return {
      jobId: args.jobId,
      reportId: persisted.reportId,
      passed: critique.pass,
      revisionsApplied,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await setJobStatusStep(args.jobId, {
      status: 'error',
      error: msg,
      completedAt: new Date(),
    });
    throw err;
  }
}

// Local helper used inside step functions only — not a step itself
// (steps don't call other steps; they just call regular DB code).
async function loadCycleAndCeoInline(cycleId: string): Promise<CycleAndCeo> {
  const [cycle] = await db
    .select()
    .from(cycles)
    .where(eq(cycles.id, cycleId))
    .limit(1);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);
  const [ceo] = await db
    .select()
    .from(ceos)
    .where(eq(ceos.id, cycle.ceoId))
    .limit(1);
  if (!ceo) throw new Error(`CEO for cycle ${cycleId} not found`);
  return { cycle, ceo };
}
