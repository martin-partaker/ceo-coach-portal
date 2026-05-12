import { z } from 'zod';
import { createHash } from 'node:crypto';
import { eq, and, asc, desc, inArray, ne } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { anthropic } from '@/lib/anthropic/client';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import {
  cycles,
  ceos,
  reports,
  coaches,
  curriculum,
  cycleFacts as cycleFactsTable,
  reportCritiques,
  reportPins,
  reportRefinements,
  reportGenerationJobs,
} from '@/db/schema';
import { buildPrompt } from '@/lib/prompts/builder';
import { MODELS } from '@/lib/anthropic/models';
import {
  createGenerationJob,
  loadCycleFactsRow,
  composeEmailRawText,
} from '@/lib/prompts/v2/orchestrate';
import { start, getRun } from 'workflow/api';
import { generateReportWorkflow } from '@/workflows/generate-report';
import { buildV2IterationBundle } from '@/lib/prompts/v2/iteration-bundle';
import { fetchCycleContext } from '@/lib/prompts/v2/context';
import {
  refineSection as refineSectionAi,
  applyRefinement,
} from '@/lib/prompts/v2/refine-section';
import {
  REFINABLE_SECTIONS,
  type CycleFacts as CycleFactsT,
  type Patterns as PatternsT,
  type DraftedReport,
  type RefinableSection,
} from '@/lib/prompts/v2/schemas';

/**
 * Shape of the JSON the model is asked to return — see the prompt
 * builder. Both the email keys and the SCOPE-mandated 6-section report
 * are siblings so the operator can choose which view to copy.
 */
interface GeneratedContent {
  // Email view
  subject_line?: string;
  opening?: string;
  wins_and_progress?: string;
  honest_feedback?: string;
  key_insight?: string;
  commitments?: string;
  going_deeper?: string;
  closing?: string;
  // Structured report view
  report?: {
    progressSummary?: string;
    keyWins?: string[];
    challenges?: string[];
    patternObservations?: string;
    suggestedNextSteps?: string[];
    suggestedResourceIds?: string[];
  };
}

function contentJsonToRawText(json: GeneratedContent): string {
  // Build a copy-pasteable email — order matters here. Going Deeper
  // sits just before the closing so the CEO reads the coaching first
  // and the reading list as a follow-up.
  const parts: string[] = [];
  if (json.opening) parts.push(json.opening);
  if (json.wins_and_progress) parts.push(json.wins_and_progress);
  if (json.honest_feedback) parts.push(json.honest_feedback);
  if (json.key_insight) parts.push(json.key_insight);
  if (json.commitments) parts.push(json.commitments);
  if (json.going_deeper && json.going_deeper.trim()) {
    parts.push(`**Going deeper this month**\n\n${json.going_deeper.trim()}`);
  }
  if (json.closing) parts.push(json.closing);
  return parts.join('\n\n');
}

/**
 * Stale-job reaper. Vercel function maxDuration is 300s; in worst-case
 * runs (long Stage C + 2 revision loops) the pipeline can hit the wall
 * and the function exits without writing a terminal status. The job row
 * is then frozen in a non-terminal state and the UI spins forever.
 *
 * Detection: any non-terminal row whose `updatedAt` is older than the
 * stall threshold is presumed dead — the orchestrator updates the row
 * at every stage transition, so an `updatedAt` gap that long means
 * either the function timed out, was killed by a deploy, or hung on
 * an Anthropic call past the request budget.
 *
 * The reaper writes the terminal state inside the read query (idempotent
 * — once written, subsequent reads see status='error' and skip the
 * reap branch). Avoids needing a separate cron.
 */
const STALE_THRESHOLD_MS = 6 * 60 * 1000; // 1 min beyond Vercel maxDuration=300s
async function reapIfStale<
  T extends {
    id: string;
    status: string;
    updatedAt: Date;
  },
>(db: typeof import('@/db').db, job: T): Promise<T> {
  if (job.status === 'complete' || job.status === 'error') return job;
  const ageMs = Date.now() - new Date(job.updatedAt).getTime();
  if (ageMs <= STALE_THRESHOLD_MS) return job;
  const ageMin = Math.floor(ageMs / 60_000);
  const errMsg =
    `Generation timed out — no progress for ${ageMin} min. ` +
    `Vercel functions cap at 5 min, and the pipeline likely exited mid-stage. ` +
    `Click Re-generate (fast) to retry; cached facts are reused so it'll start at the drafting step.`;
  await db
    .update(reportGenerationJobs)
    .set({
      status: 'error',
      error: errMsg,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(reportGenerationJobs.id, job.id));
  return { ...job, status: 'error', error: errMsg } as T;
}

/**
 * Validate `report.suggestedResourceIds` against the curriculum table.
 * The model occasionally invents UUIDs — keep only ones that resolve.
 */
async function sanitiseSuggestedResources(
  db: typeof import('@/db').db,
  ids: string[] | undefined,
): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  // Cap at 5 to keep the prompt + UI from running away even if the
  // model returns more than the requested 1–3.
  const candidates = ids.filter((id) => /^[0-9a-fA-F-]{36}$/.test(id)).slice(0, 5);
  if (candidates.length === 0) return [];
  const rows = await db
    .select({ id: curriculum.id })
    .from(curriculum)
    .where(inArray(curriculum.id, candidates));
  const valid = new Set(rows.map((r) => r.id));
  return candidates.filter((id) => valid.has(id));
}

/**
 * Resolve the cycle + CEO. Super admins bypass the coach-ownership check so
 * they can drive generate/preview from the admin workspace for any CEO,
 * not only their own roster.
 */
async function loadCycleAndCeo(
  ctx: { db: typeof import('@/db').db; coach: { id: string }; realCoach: { isSuperAdmin: boolean } | null },
  cycleId: string
) {
  const [cycle] = await ctx.db
    .select()
    .from(cycles)
    .where(eq(cycles.id, cycleId))
    .limit(1);
  if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

  const ceoFilter = ctx.realCoach?.isSuperAdmin
    ? eq(ceos.id, cycle.ceoId)
    : and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id));

  const [ceo] = await ctx.db.select().from(ceos).where(ceoFilter).limit(1);
  if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

  return { cycle, ceo };
}

/**
 * Load every previously-generated report for this CEO that came before the
 * current cycle, ordered oldest → newest so the AI sees the progression.
 *
 * "Previous" means a cycle whose `periodEnd` is strictly before this
 * cycle's `periodStart` — i.e. fully non-overlapping and finished. This
 * is important now that cycles can overlap (e.g. an Apr "Feb–Jun"
 * retrospective alongside Mar 2026 monthly): we don't want sibling /
 * overlapping cycles to be listed as "prior context."
 *
 * When a cycle has no period dates, fall back to `createdAt` ordering
 * so legacy data without a configured window still works.
 *
 * Cycles that never had a report generated are skipped — only reports
 * that actually exist are returned.
 */
async function loadPreviousReports(
  ctx: { db: typeof import('@/db').db },
  ceoId: string,
  currentCycleId: string,
): Promise<
  Array<{
    cycleLabel: string;
    rawText: string;
    /** The structured `report.patternObservations` from this cycle's
     *  saved contentJson (when present). The prompt surfaces these as
     *  their own block so the model can compare/contrast across months
     *  rather than re-reading them out of long email bodies. */
    patternObservations?: string | null;
  }>
> {
  const [currentCycle] = await ctx.db
    .select()
    .from(cycles)
    .where(eq(cycles.id, currentCycleId))
    .limit(1);
  if (!currentCycle) return [];

  const allCycles = await ctx.db
    .select()
    .from(cycles)
    .where(eq(cycles.ceoId, ceoId));

  const isPrior = (c: (typeof allCycles)[number]): boolean => {
    if (c.id === currentCycleId) return false;
    if (currentCycle.periodStart && c.periodEnd) {
      return c.periodEnd < currentCycle.periodStart;
    }
    return c.createdAt.getTime() < currentCycle.createdAt.getTime();
  };

  const sortKey = (c: (typeof allCycles)[number]): string =>
    c.periodEnd ?? c.createdAt.toISOString();

  const priorCyclesOldestFirst = allCycles
    .filter(isPrior)
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

  const out: Array<{
    cycleLabel: string;
    rawText: string;
    patternObservations?: string | null;
  }> = [];
  for (const c of priorCyclesOldestFirst) {
    const [r] = await ctx.db
      .select()
      .from(reports)
      .where(eq(reports.cycleId, c.id))
      .orderBy(desc(reports.generatedAt))
      .limit(1);
    if (r) {
      const json = r.contentJson as
        | { report?: { patternObservations?: string | null } }
        | null;
      out.push({
        cycleLabel: c.label,
        rawText: r.rawText,
        patternObservations: json?.report?.patternObservations ?? null,
      });
    }
  }
  return out;
}

export const reportsRouter = createTRPCRouter({
  getForCycle: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, input.cycleId))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      const ceoFilter = ctx.realCoach?.isSuperAdmin
        ? eq(ceos.id, cycle.ceoId)
        : and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id));
      const [ceo] = await ctx.db.select().from(ceos).where(ceoFilter).limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.cycleId, input.cycleId))
        .orderBy(desc(reports.generatedAt))
        .limit(1);

      return report ?? null;
    }),

  /**
   * Returns the prompt that `generate` would build, without calling Claude
   * or persisting anything. Used by the "Inspect prompt" inspector so the
   * coach/admin can see exactly what the model will see.
   */
  previewPrompt: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { cycle, ceo } = await loadCycleAndCeo(ctx, input.cycleId);

      // Resolve the cycle's coach name (super admins may not be the coach,
      // so we read it off the CEO row rather than ctx.coach). Unassigned
      // CEOs simply get a placeholder coach name in the prompt.
      const [coach] = ceo.coachId
        ? await ctx.db
            .select()
            .from(coaches)
            .where(eq(coaches.id, ceo.coachId))
            .limit(1)
        : [];

      const previousReports = await loadPreviousReports(ctx, ceo.id, input.cycleId);

      const { systemPrompt, userPrompt, missing, contextFiles } = await buildPrompt({
        cycle,
        ceo,
        coachName: coach?.name ?? '(unknown coach)',
        previousReports,
      });

      return {
        systemPrompt,
        userPrompt,
        missing,
        contextFiles,
        ceoName: ceo.name,
        cycleLabel: cycle.label,
      };
    }),

  generate: protectedProcedure
    .input(z.object({
      cycleId: z.string().uuid(),
      feedback: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { cycle, ceo } = await loadCycleAndCeo(ctx, input.cycleId);

      const previousReports = await loadPreviousReports(ctx, ceo.id, input.cycleId);

      // Resolve the assigned coach (not ctx.coach) — super admins may
      // generate on behalf of another coach's CEO and the email must
      // be signed by that coach. Unassigned CEOs fall back to ctx.coach
      // so the email still has a sender identity.
      const [assignedCoach] = ceo.coachId
        ? await ctx.db
            .select()
            .from(coaches)
            .where(eq(coaches.id, ceo.coachId))
            .limit(1)
        : [];

      // Build prompt
      const { systemPrompt, userPrompt, missing } = await buildPrompt({
        cycle,
        ceo,
        coachName: assignedCoach?.name ?? ctx.coach.name,
        previousReports,
      });

      // Get current report if regenerating with feedback
      let currentReport = null;
      if (input.feedback) {
        const [existing] = await ctx.db
          .select()
          .from(reports)
          .where(eq(reports.cycleId, input.cycleId))
          .orderBy(desc(reports.generatedAt))
          .limit(1);
        currentReport = existing ?? null;
      }

      // Build messages — include feedback conversation if regenerating
      const messages: { role: 'user' | 'assistant'; content: string }[] = [
        { role: 'user', content: userPrompt },
      ];

      if (currentReport && input.feedback) {
        messages.push(
          { role: 'assistant', content: JSON.stringify(currentReport.contentJson) },
          { role: 'user', content: `The coach wants changes to this email. Here is their feedback:\n\n${input.feedback}\n\nPlease regenerate the email incorporating this feedback. Return the same JSON format.` },
        );
      }

      // Call Claude
      const modelId = MODELS.reportPrimary;
      const message = await anthropic.messages.create({
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      });

      // Extract text response
      const textBlock = message.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'No text response from AI',
        });
      }

      // Parse JSON
      let contentJson: GeneratedContent;
      try {
        contentJson = JSON.parse(textBlock.text);
      } catch {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to parse AI response as JSON. Raw response saved.',
        });
      }

      // Validate suggestedResourceIds against the curriculum table —
      // the model sometimes invents UUIDs; we drop unknowns rather than
      // surfacing dead links to the operator.
      if (contentJson.report) {
        contentJson.report.suggestedResourceIds = await sanitiseSuggestedResources(
          ctx.db,
          contentJson.report.suggestedResourceIds,
        );
      }

      const rawText = contentJsonToRawText(contentJson);

      // Store report. Prompt version bumped to 2 — output now carries
      // the structured 6-section report alongside the email keys, and
      // includes validated `suggestedResourceIds` from the curriculum.
      const [report] = await ctx.db
        .insert(reports)
        .values({
          cycleId: input.cycleId,
          contentJson: contentJson as unknown as Record<string, unknown>,
          rawText,
          modelUsed: modelId,
          promptVersion: 2,
        })
        .returning();

      return { report, missing };
    }),

  /**
   * Resolve the curriculum rows referenced by a report's
   * `suggestedResourceIds` so the UI can render titles + summaries
   * without doing N round-trips. Cheap admin/coach query — gated only
   * by procedure auth, not by row scope, because curriculum is shared.
   */
  resolveSuggestedResources: protectedProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).max(10) }))
    .query(async ({ ctx, input }) => {
      if (input.ids.length === 0) return [];
      const rows = await ctx.db
        .select({
          id: curriculum.id,
          title: curriculum.title,
          summary: curriculum.summary,
          classNumber: curriculum.classNumber,
          section: curriculum.section,
          slug: curriculum.slug,
        })
        .from(curriculum)
        .where(inArray(curriculum.id, input.ids));
      // Preserve caller's order so the UI matches what the model picked.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return input.ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    }),

  /**
   * Search the curriculum catalog for the resource-picker UI in the
   * report reviewer. Matches title/section/summary against the query.
   * Admin/coach scope — no row-level access control because curriculum
   * is shared content.
   */
  searchCurriculum: protectedProcedure
    .input(z.object({ q: z.string().max(120).optional(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const q = input.q?.trim().toLowerCase() ?? '';
      const rows = await ctx.db
        .select({
          id: curriculum.id,
          title: curriculum.title,
          summary: curriculum.summary,
          classNumber: curriculum.classNumber,
          section: curriculum.section,
          slug: curriculum.slug,
          kind: curriculum.kind,
        })
        .from(curriculum)
        .orderBy(curriculum.sortOrder);
      const filtered = q
        ? rows.filter((r) => {
            const hay = [r.title, r.section ?? '', r.summary ?? '']
              .join(' ')
              .toLowerCase();
            return hay.includes(q);
          })
        : rows;
      return filtered.slice(0, input.limit);
    }),

  /**
   * Coach curation: edit the email body sections and the suggested
   * resource list after generation. Re-derives `rawText` server-side so
   * "Copy email" reflects the curated state. Coach-scoped — only the
   * CEO's owning coach (or super-admin) can curate.
   */
  update: protectedProcedure
    .input(
      z.object({
        reportId: z.string().uuid(),
        // Email keys the coach can edit inline. Anything omitted is
        // left untouched on the persisted JSON.
        opening: z.string().optional(),
        wins_and_progress: z.string().optional(),
        honest_feedback: z.string().optional(),
        key_insight: z.string().optional(),
        commitments: z.string().optional(),
        going_deeper: z.string().optional(),
        closing: z.string().optional(),
        subject_line: z.string().optional(),
        // Curated resource id list (replaces the stored array entirely).
        suggestedResourceIds: z.array(z.string().uuid()).max(10).optional(),
        // Structured report fields — same edit-in-place treatment as the
        // email keys. Coach can tweak the AI's narrative without having
        // to regenerate the whole report.
        progressSummary: z.string().optional(),
        keyWins: z.array(z.string()).optional(),
        challenges: z.array(z.string()).optional(),
        patternObservations: z.string().optional(),
        suggestedNextSteps: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });

      // Verify the caller owns the cycle (or is unscoped admin).
      await loadCycleAndCeo(ctx, report.cycleId);

      const current = (report.contentJson ?? {}) as GeneratedContent;
      const next: GeneratedContent = { ...current };

      const emailKeys = [
        'opening',
        'wins_and_progress',
        'honest_feedback',
        'key_insight',
        'commitments',
        'going_deeper',
        'closing',
        'subject_line',
      ] as const;
      for (const k of emailKeys) {
        if (input[k] !== undefined) next[k] = input[k];
      }

      if (input.suggestedResourceIds !== undefined) {
        const validIds = await sanitiseSuggestedResources(ctx.db, input.suggestedResourceIds);
        next.report = {
          ...(next.report ?? {}),
          suggestedResourceIds: validIds,
        };
      }

      // Structured report edits. We replace each field outright when
      // present so a coach can clear a section by sending an empty
      // string / array.
      const structuredKeys = [
        'progressSummary',
        'keyWins',
        'challenges',
        'patternObservations',
        'suggestedNextSteps',
      ] as const;
      for (const k of structuredKeys) {
        if (input[k] !== undefined) {
          next.report = {
            ...(next.report ?? {}),
            [k]: input[k],
          };
        }
      }

      const rawText = contentJsonToRawText(next);
      const [updated] = await ctx.db
        .update(reports)
        .set({
          contentJson: next as unknown as Record<string, unknown>,
          rawText,
        })
        .where(eq(reports.id, report.id))
        .returning();
      return updated;
    }),

  /**
   * Re-run the AI for a single section of an existing report. The coach
   * keeps everything else they've curated and only swaps in a fresh take
   * on the targeted field. Optional `feedback` lets them say what was
   * wrong with the current version.
   *
   * The model is asked to return the same full JSON shape; we then pluck
   * out only the requested field and merge it into the persisted report
   * (re-deriving rawText so the email view stays coherent).
   */
  regenerateSection: protectedProcedure
    .input(
      z.object({
        reportId: z.string().uuid(),
        field: z.enum([
          'progressSummary',
          'keyWins',
          'challenges',
          'patternObservations',
          'suggestedNextSteps',
        ]),
        feedback: z.string().trim().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });

      const { cycle, ceo } = await loadCycleAndCeo(ctx, report.cycleId);
      const previousReports = await loadPreviousReports(ctx, ceo.id, cycle.id);

      const [assignedCoach] = ceo.coachId
        ? await ctx.db
            .select()
            .from(coaches)
            .where(eq(coaches.id, ceo.coachId))
            .limit(1)
        : [];

      const { systemPrompt, userPrompt } = await buildPrompt({
        cycle,
        ceo,
        coachName: assignedCoach?.name ?? ctx.coach.name,
        previousReports,
      });

      // Hand the model the existing report so it has the surrounding
      // context (other sections it shouldn't touch, the coach's prior
      // edits) and ask for a targeted refresh of just the named field.
      const focusInstruction =
        `The coach wants a fresh take on ONLY the "${input.field}" section. ` +
        `Keep the same JSON shape as before, but return your best new content for ` +
        `that field — the others can be empty placeholders, we'll discard them. ` +
        (input.feedback
          ? `\n\nFeedback from the coach:\n${input.feedback}\n\n`
          : '\n\n') +
        `Treat the prior contentJson below as the current state. Return the same ` +
        `JSON format.`;

      const messages: { role: 'user' | 'assistant'; content: string }[] = [
        { role: 'user', content: userPrompt },
        {
          role: 'assistant',
          content: JSON.stringify(report.contentJson ?? {}),
        },
        { role: 'user', content: focusInstruction },
      ];

      const modelId = MODELS.reportPrimary;
      const message = await anthropic.messages.create({
        model: modelId,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
      });

      const textBlock = message.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'No text response from AI',
        });
      }

      let parsed: GeneratedContent;
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to parse AI response as JSON.',
        });
      }

      const refreshed = parsed.report?.[input.field];
      if (refreshed === undefined || refreshed === null) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `AI didn't return content for "${input.field}".`,
        });
      }

      // Merge: keep everything except the targeted field, swap that one.
      const current = (report.contentJson ?? {}) as GeneratedContent;
      const next: GeneratedContent = {
        ...current,
        report: {
          ...(current.report ?? {}),
          [input.field]: refreshed,
        },
      };

      const rawText = contentJsonToRawText(next);
      const [updated] = await ctx.db
        .update(reports)
        .set({
          contentJson: next as unknown as Record<string, unknown>,
          rawText,
        })
        .where(eq(reports.id, report.id))
        .returning();
      return updated;
    }),

  // ════════════════════════════════════════════════════════════════════
  // v2 pipeline (Stages A → B → C → D → E)
  // ════════════════════════════════════════════════════════════════════

  /** Kick off the v2 pipeline asynchronously. Creates a job row,
   *  starts the `generateReportWorkflow` Vercel Workflow, and returns
   *  the jobId immediately. The client polls `getActiveJob` for stage
   *  progress; each Stage runs in its own function invocation so the
   *  pipeline isn't bounded by the route handler's maxDuration.
   *
   *  Pipeline: extractFacts → matchPatterns → draft → critique (+ up
   *  to 2 revision passes). Persists CycleFacts, the report, the
   *  critique, and updates the job row at every stage transition. */
  generateV2: protectedProcedure
    .input(
      z.object({
        cycleId: z.string().uuid(),
        // Default false: a retry after a Stage C/D/E failure reuses the
        // already-extracted facts and patterns, saving ~50–80s. Set true
        // when the operator has actually changed the cycle inputs and
        // wants the model to re-read them from scratch.
        forceRefreshFacts: z.boolean().default(false),
        // Generation mode:
        //  - 'instant' — single-shot legacy generator. ~30–60s.
        //  - 'quick'   — extract + match + draft (no rubric). ~1–2 min.
        //  - 'full'    — adds critique + revisions. ~3–5 min.
        mode: z.enum(['instant', 'quick', 'full']).default('full'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { cycle, ceo } = await loadCycleAndCeo(ctx, input.cycleId);
      const [assignedCoach] = ceo.coachId
        ? await ctx.db
            .select()
            .from(coaches)
            .where(eq(coaches.id, ceo.coachId))
            .limit(1)
        : [];

      const jobId = await createGenerationJob(input.cycleId, input.mode);
      const coachName = assignedCoach?.name ?? ctx.coach.name;

      // Hand the pipeline off to Vercel Workflow. start() returns
      // immediately with a runId; each step inside the workflow runs in
      // its own function invocation, so the pipeline isn't bounded by
      // the route handler's maxDuration. The runId is persisted on the
      // job row so cancelGeneration can call run.cancel() on the
      // workflow runtime, not just flip the DB row.
      try {
        const run = await start(generateReportWorkflow, [
          {
            jobId,
            cycleId: input.cycleId,
            coachName,
            forceRefreshFacts: input.forceRefreshFacts,
            mode: input.mode,
          },
        ]);
        await ctx.db
          .update(reportGenerationJobs)
          .set({ workflowRunId: run.runId, updatedAt: new Date() })
          .where(eq(reportGenerationJobs.id, jobId));
      } catch (e) {
        // start() failed — the workflow runtime didn't accept the run.
        // Mark the job as error so the UI exits the running state and
        // surfaces a clear message instead of polling forever.
        const msg = e instanceof Error ? e.message : 'unknown error';
        console.error('[generateV2 start failed]', jobId, e);
        await ctx.db
          .update(reportGenerationJobs)
          .set({
            status: 'error',
            error: `Workflow start failed: ${msg}`,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(reportGenerationJobs.id, jobId));
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Workflow start failed: ${msg}`,
        });
      }
      // Suppress unused — `cycle` and `ceo` were loaded purely to
      // ownership-check before kicking off the workflow.
      void cycle;
      void ceo;

      return { jobId, cycleId: input.cycleId };
    }),

  /** Bundle for "break out to LLM" — v2 equivalent of previewPrompt.
   *  Returns the polished report, typed CycleFacts, Patterns, the
   *  Critique, raw context, the v1-shaped contextFiles list (so the
   *  download-zip flow can reuse the existing renderer), and a
   *  fully-loaded "let's iterate" markdown prompt the coach can paste
   *  into any off-platform LLM. */
  getV2IterationBundle: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await loadCycleAndCeo(ctx, input.cycleId);
      return buildV2IterationBundle({ cycleId: input.cycleId });
    }),

  /** Returns the latest v1 (promptVersion < 3) and latest v2
   *  (promptVersion = 3) reports for a cycle plus the latest job row.
   *  Drives the modal's version toggle and the firstDraft → polished
   *  diff view. */
  getReportVersions: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await loadCycleAndCeo(ctx, input.cycleId);

      const allReports = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.cycleId, input.cycleId))
        .orderBy(desc(reports.generatedAt));

      const v1 = allReports.find((r) => r.promptVersion < 3) ?? null;
      const v2 = allReports.find((r) => r.promptVersion >= 3) ?? null;

      const [latestJob] = await ctx.db
        .select()
        .from(reportGenerationJobs)
        .where(eq(reportGenerationJobs.cycleId, input.cycleId))
        .orderBy(desc(reportGenerationJobs.startedAt))
        .limit(1);

      return {
        v1,
        v2,
        latestJob: latestJob ?? null,
      };
    }),

  /** Latest generation job for a cycle, in any state. The UI uses
   *  this for progress polling (1.5s interval while non-terminal) and
   *  to render the live pipeline progress bar. */
  getActiveJob: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await loadCycleAndCeo(ctx, input.cycleId);
      const [latest] = await ctx.db
        .select()
        .from(reportGenerationJobs)
        .where(eq(reportGenerationJobs.cycleId, input.cycleId))
        .orderBy(desc(reportGenerationJobs.startedAt))
        .limit(1);
      if (!latest) return null;
      return await reapIfStale(ctx.db, latest);
    }),

  /**
   * Cancel an in-flight generation. Sets the job to status='error' with
   * a "Cancelled by user" message so the UI exits the running state and
   * stops polling. The underlying Vercel function may still be running
   * (we can't kill it remotely), but the result will be ignored — the
   * orchestrator's writes use this same row, so when it finishes it
   * harmlessly overwrites the cancellation. The user can immediately
   * trigger a new generation, which spawns a fresh job row.
   */
  cancelGeneration: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [job] = await ctx.db
        .select()
        .from(reportGenerationJobs)
        .where(eq(reportGenerationJobs.id, input.jobId))
        .limit(1);
      if (!job) throw new TRPCError({ code: 'NOT_FOUND' });
      // Verify auth via the cycle's CEO ownership (same as elsewhere).
      await loadCycleAndCeo(ctx, job.cycleId);
      if (job.status === 'complete' || job.status === 'error') {
        return { ok: true, alreadyTerminal: true };
      }
      // Tell the workflow runtime to stop scheduling further steps.
      // Best-effort: a step already in flight will run to completion,
      // but no new ones will fire and the workflow's own catch/finally
      // won't overwrite the cancellation message because we mark the
      // job row terminal right after. If runId is missing (job created
      // before this column existed), skip and just flip the row.
      if (job.workflowRunId) {
        try {
          await getRun(job.workflowRunId).cancel();
        } catch (e) {
          // Cancel is best-effort — log and proceed to mark the row.
          console.warn('[cancelGeneration] workflow cancel failed', e);
        }
      }
      await ctx.db
        .update(reportGenerationJobs)
        .set({
          status: 'error',
          error: 'Cancelled by user.',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(reportGenerationJobs.id, input.jobId));
      return { ok: true, alreadyTerminal: false };
    }),

  /** Job row that produced a specific report — exposes the run's mode,
   *  revisions applied, and stage history for the report's debug view. */
  getJobForReport: protectedProcedure
    .input(z.object({ reportId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadCycleAndCeo(ctx, report.cycleId);

      const [job] = await ctx.db
        .select()
        .from(reportGenerationJobs)
        .where(eq(reportGenerationJobs.finalReportId, input.reportId))
        .orderBy(desc(reportGenerationJobs.startedAt))
        .limit(1);
      return job ?? null;
    }),

  /** All currently-running jobs for the requesting coach's CEOs.
   *  Drives the global "background pill" toast — if the coach
   *  navigates away mid-generation, the pill stays visible until
   *  every active job hits a terminal status. */
  listActiveJobs: protectedProcedure.query(async ({ ctx }) => {
    const myCeos = ctx.realCoach?.isSuperAdmin
      ? await ctx.db.select({ id: ceos.id, name: ceos.name }).from(ceos)
      : await ctx.db
          .select({ id: ceos.id, name: ceos.name })
          .from(ceos)
          .where(eq(ceos.coachId, ctx.coach.id));
    if (myCeos.length === 0) return [];

    const myCycles = await ctx.db
      .select({ id: cycles.id, label: cycles.label, ceoId: cycles.ceoId })
      .from(cycles)
      .where(
        inArray(
          cycles.ceoId,
          myCeos.map((c) => c.id),
        ),
      );
    if (myCycles.length === 0) return [];

    const ceoById = new Map(myCeos.map((c) => [c.id, c.name]));
    const cycleById = new Map(myCycles.map((c) => [c.id, c]));

    const active = await ctx.db
      .select()
      .from(reportGenerationJobs)
      .where(
        and(
          inArray(
            reportGenerationJobs.cycleId,
            myCycles.map((c) => c.id),
          ),
          ne(reportGenerationJobs.status, 'complete'),
          ne(reportGenerationJobs.status, 'error'),
        ),
      )
      .orderBy(desc(reportGenerationJobs.startedAt));

    // Reap stale rows so the global pill clears for jobs whose function
    // died mid-pipeline. Each row that's reaped becomes 'error', which
    // drops it out of the active set on the next poll naturally.
    const reaped = await Promise.all(active.map((j) => reapIfStale(ctx.db, j)));
    const stillActive = reaped.filter(
      (j) => j.status !== 'complete' && j.status !== 'error',
    );

    return stillActive.map((j) => {
      const c = cycleById.get(j.cycleId);
      return {
        ...j,
        cycleLabel: c?.label ?? '(cycle)',
        ceoName: c ? (ceoById.get(c.ceoId) ?? '(CEO)') : '(CEO)',
      };
    });
  }),

  /** Read the latest critique for a report. The UI renders pass/fail per
   *  rubric item + the topFix sentence. */
  getCritique: protectedProcedure
    .input(z.object({ reportId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadCycleAndCeo(ctx, report.cycleId);

      const [latest] = await ctx.db
        .select()
        .from(reportCritiques)
        .where(eq(reportCritiques.reportId, input.reportId))
        .orderBy(desc(reportCritiques.generatedAt))
        .limit(1);
      return latest ?? null;
    }),

  /** Read the persisted CycleFacts + Patterns for a cycle. Drives the
   *  source-attribution UI (hover a claim, see which journal/transcript
   *  excerpt it came from) and the coachReviewFlags callouts. */
  getFacts: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, input.cycleId))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadCycleAndCeo(ctx, input.cycleId);

      const row = await loadCycleFactsRow(input.cycleId);
      return row;
    }),

  /** List the per-section refinement chat history for a report.
   *  Returned grouped by section so the UI can render one panel per
   *  section with its own conversation. */
  listRefinements: protectedProcedure
    .input(z.object({ reportId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadCycleAndCeo(ctx, report.cycleId);

      const rows = await ctx.db
        .select()
        .from(reportRefinements)
        .where(eq(reportRefinements.reportId, input.reportId))
        .orderBy(asc(reportRefinements.createdAt));

      const grouped: Record<string, typeof rows> = {};
      for (const r of rows) {
        (grouped[r.section] ??= []).push(r);
      }
      return grouped;
    }),

  /** Stage E — per-section refinement chat turn.
   *
   *  The coach sends a message scoped to a single section. We:
   *    1. Load CycleFacts + Patterns + current draft from DB.
   *    2. Load prior chat history for this (report, section).
   *    3. Load any pinned paragraphs in this section.
   *    4. Call the model with all of that context.
   *    5. Apply the new section value into contentJson, recompute rawText.
   *    6. Append the user turn + assistant turn to reportRefinements.
   */
  refineSectionV2: protectedProcedure
    .input(
      z.object({
        reportId: z.string().uuid(),
        section: z.enum(REFINABLE_SECTIONS),
        message: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });

      const { cycle, ceo } = await loadCycleAndCeo(ctx, report.cycleId);
      const [assignedCoach] = ceo.coachId
        ? await ctx.db
            .select()
            .from(coaches)
            .where(eq(coaches.id, ceo.coachId))
            .limit(1)
        : [];

      const factsRow = await loadCycleFactsRow(report.cycleId);
      if (!factsRow) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'No CycleFacts on file for this cycle yet. Generate the report via v2 first so refinement has typed facts to ground in.',
        });
      }
      const facts = factsRow.factsJson as CycleFactsT;
      const patterns = (factsRow.patternsJson ?? null) as PatternsT | null;

      const cycleCtx = await fetchCycleContext({
        cycle,
        ceo,
        coachName: assignedCoach?.name ?? ctx.coach.name,
      });

      const history = await ctx.db
        .select()
        .from(reportRefinements)
        .where(
          and(
            eq(reportRefinements.reportId, input.reportId),
            eq(reportRefinements.section, input.section),
          ),
        )
        .orderBy(asc(reportRefinements.createdAt));

      const pins = await ctx.db
        .select()
        .from(reportPins)
        .where(
          and(
            eq(reportPins.reportId, input.reportId),
            eq(reportPins.section, input.section),
          ),
        );

      const currentDraft = report.contentJson as DraftedReport;

      const refinement = await refineSectionAi({
        ctx: cycleCtx,
        facts,
        patterns: patterns ?? {
          carryingForward: [],
          evolving: [],
          resolving: [],
          newThisCycle: [],
          isFirstCycle: cycleCtx.isFirstCycle,
        },
        currentDraft,
        section: input.section,
        userMessage: input.message,
        history: history.map((h) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        })),
        pinnedParagraphs: pins.map((p) => p.paragraphText),
      });

      const nextDraft = applyRefinement(
        currentDraft,
        input.section as RefinableSection,
        refinement.newValue,
      );
      const rawText = composeEmailRawText(nextDraft);

      // Append both turns and update the report in one transaction-ish
      // shot. drizzle-orm doesn't expose a transaction shorthand here;
      // sequential inserts + update is fine — the worst case on partial
      // failure is a stranded user turn the UI shows but no assistant
      // reply, which the coach can re-run.
      await ctx.db.insert(reportRefinements).values([
        {
          reportId: input.reportId,
          section: input.section,
          role: 'user',
          content: input.message,
          sectionSnapshot: null,
        },
        {
          reportId: input.reportId,
          section: input.section,
          role: 'assistant',
          content: refinement.rawText,
          sectionSnapshot: refinement.snapshot,
        },
      ]);

      const [updated] = await ctx.db
        .update(reports)
        .set({
          contentJson: nextDraft as unknown as Record<string, unknown>,
          rawText,
        })
        .where(eq(reports.id, input.reportId))
        .returning();

      return { report: updated, snapshot: refinement.snapshot };
    }),

  /** Pin a paragraph in a section so it's preserved across regenerations
   *  and refinements. Stores both a stable hash of the text (for "is it
   *  still here?" checks) and the verbatim text (for re-insertion). */
  pinParagraph: protectedProcedure
    .input(
      z.object({
        reportId: z.string().uuid(),
        section: z.enum(REFINABLE_SECTIONS),
        paragraphText: z.string().trim().min(1).max(8000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadCycleAndCeo(ctx, report.cycleId);

      const paragraphHash = createHash('sha256')
        .update(input.paragraphText.trim())
        .digest('hex')
        .slice(0, 32);

      const [pin] = await ctx.db
        .insert(reportPins)
        .values({
          reportId: input.reportId,
          section: input.section,
          paragraphHash,
          paragraphText: input.paragraphText.trim(),
        })
        .onConflictDoNothing()
        .returning();
      return pin ?? null;
    }),

  unpinParagraph: protectedProcedure
    .input(z.object({ pinId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [pin] = await ctx.db
        .select()
        .from(reportPins)
        .where(eq(reportPins.id, input.pinId))
        .limit(1);
      if (!pin) throw new TRPCError({ code: 'NOT_FOUND' });

      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, pin.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadCycleAndCeo(ctx, report.cycleId);

      await ctx.db.delete(reportPins).where(eq(reportPins.id, input.pinId));
      return { ok: true };
    }),

  listPins: protectedProcedure
    .input(z.object({ reportId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, input.reportId))
        .limit(1);
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadCycleAndCeo(ctx, report.cycleId);

      return ctx.db
        .select()
        .from(reportPins)
        .where(eq(reportPins.reportId, input.reportId))
        .orderBy(asc(reportPins.createdAt));
    }),
});
