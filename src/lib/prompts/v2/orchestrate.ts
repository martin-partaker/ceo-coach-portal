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
import {
  CycleFactsSchema,
  PatternsSchema,
  type DraftedReport,
  type CycleFacts,
  type Patterns,
  type RefinableSection,
} from './schemas';
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

export type GenerationMode = 'quick' | 'full';

export type OrchestrateArgs = {
  jobId: string;
  cycle: Cycle;
  ceo: Ceo;
  coachName: string;
  /** When true, skip the cycle_facts cache and always re-run Stage A
   *  (extract-facts) + Stage B (match-patterns). Default false: if a
   *  prior run already persisted facts/patterns for this cycle, we reuse
   *  them and jump straight to Stage C, which makes retries after a
   *  Stage C/D/E hiccup ~50–80s faster on a typical cycle. Set this when
   *  the operator has actually changed the cycle inputs and needs a
   *  fresh extraction. */
  forceRefreshFacts?: boolean;
  /** 'quick' skips Stage D (critique) and Stage E (revisions): the
   *  first draft is persisted as the final report. ~80–200s faster on
   *  the upper bound vs 'full', at the cost of no rubric self-check.
   *  Default: 'full'. */
  mode?: GenerationMode;
};

export type OrchestrateResult = {
  jobId: string;
  reportId: string;
  contentJson: DraftedReport;
  rawText: string;
  modelUsed: string;
  factsId: string;
  /** Null in quick mode (no critique row was inserted). */
  critiqueId: string | null;
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

    // ── Stages A + B (or reuse from cache) ───────────────────────────
    // If a prior run for this cycle already persisted facts + patterns,
    // and the operator hasn't asked for a fresh extraction, skip the two
    // slowest LLM-bound stages entirely. This is the retry escape hatch:
    // when Stage C/D/E fails the operator can re-run the pipeline without
    // paying the ~50–80s cost of re-extracting facts that haven't changed.
    let facts: CycleFacts;
    let patterns: Patterns;
    let factsRow: { id: string };
    const cached = args.forceRefreshFacts ? null : await tryLoadCachedFacts(args.cycle.id);

    if (cached) {
      facts = cached.facts;
      patterns = cached.patterns;
      factsRow = { id: cached.factsRowId };
      // Briefly mark A + B as "reused" so the progress bar's earlier
      // stages flip to complete before the live stage advances. Each
      // status flip is its own row update, so the UI sees the transition.
      await updateJob(jobId, {
        status: 'extracting_facts',
        stageDetail: { stage: 'extracting_facts', reused: true },
      });
      await updateJob(jobId, {
        status: 'matching_patterns',
        stageDetail: { stage: 'matching_patterns', reused: true, isFirstCycle: ctx.isFirstCycle },
      });
    } else {
      // Stage A
      await updateJob(jobId, {
        status: 'extracting_facts',
        stageDetail: { stage: 'extracting_facts' },
      });
      const aResult = await extractFacts(ctx);
      facts = aResult.facts;

      // Stage B
      await updateJob(jobId, {
        status: 'matching_patterns',
        stageDetail: { stage: 'matching_patterns', isFirstCycle: ctx.isFirstCycle },
      });
      const bResult = await matchPatterns({ ctx, currentFacts: facts });
      patterns = bResult.patterns;

      // Persist Facts + Patterns (upsert by cycleId).
      const factsModelLabel = `${aResult.modelUsed}+${bResult.modelUsed}`;
      const [inserted] = await db
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
      factsRow = { id: inserted.id };
    }

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

    // Stage D + E — critique + revision loop. SKIPPED in quick mode:
    // the first draft becomes the final report and we jump straight
    // to finalising. Trades self-correction for ~80–200s of wall time.
    const mode: GenerationMode = args.mode ?? 'full';
    let critique: Awaited<ReturnType<typeof critiqueReport>>['critique'] | null = null;
    let revisionsApplied = 0;

    if (mode === 'full') {
      await updateJob(jobId, {
        status: 'critiquing',
        stageDetail: { stage: 'critiquing', revision: 0 },
      });
      critique = (
        await critiqueReport({ facts, patterns, draft: currentDraft })
      ).critique;

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

    // Quick mode skips the critique entirely → no row to insert. The
    // modal's getCritique query just resolves to null and the rubric
    // gutter is hidden.
    let critiqueRowId: string | null = null;
    if (critique) {
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
      critiqueRowId = critiqueRow.id;
    }

    await updateJob(jobId, {
      status: 'complete',
      stageDetail: {
        stage: 'complete',
        mode,
        passed: critique?.pass ?? null,
        revisions: revisionsApplied,
      },
      finalReportId: reportRow.id,
      critiqueId: critiqueRowId,
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
      critiqueId: critiqueRowId,
      passed: critique?.pass ?? true, // quick mode: no rubric → treat as pass
      topFix: critique?.topFix ?? null,
      weakSections: (critique?.weakSections ?? []) as string[],
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

/**
 * Load cached facts + patterns for a cycle and validate them against
 * their schemas. Returns null on any failure path — schema drift, missing
 * patterns, missing row — so the orchestrator falls back to a clean
 * Stage A + B run instead of feeding malformed data into Stage C.
 *
 * Validation matters because the schema can evolve between deploys; an
 * old cached row from before a schema change should be re-extracted, not
 * pushed through with mismatched types that explode in Stage C.
 */
async function tryLoadCachedFacts(
  cycleId: string,
): Promise<{ facts: CycleFacts; patterns: Patterns; factsRowId: string } | null> {
  const row = await loadCycleFactsRow(cycleId);
  if (!row) return null;
  if (!row.patternsJson) return null; // partial cache (Stage B never finished) — re-run
  const factsParsed = CycleFactsSchema.safeParse(row.factsJson);
  if (!factsParsed.success) {
    console.warn(
      `[orchestrate] cached cycle_facts.factsJson failed schema validation for cycleId=${cycleId}; re-extracting.`,
    );
    return null;
  }
  const patternsParsed = PatternsSchema.safeParse(row.patternsJson);
  if (!patternsParsed.success) {
    console.warn(
      `[orchestrate] cached cycle_facts.patternsJson failed schema validation for cycleId=${cycleId}; re-extracting.`,
    );
    return null;
  }
  return { facts: factsParsed.data, patterns: patternsParsed.data, factsRowId: row.id };
}
