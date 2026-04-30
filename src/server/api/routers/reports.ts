import { z } from 'zod';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import Anthropic from '@anthropic-ai/sdk';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { cycles, ceos, reports, coaches, curriculum } from '@/db/schema';
import { buildPrompt } from '@/lib/prompts/builder';

const anthropic = new Anthropic();

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
): Promise<Array<{ cycleLabel: string; rawText: string }>> {
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

  const out: Array<{ cycleLabel: string; rawText: string }> = [];
  for (const c of priorCyclesOldestFirst) {
    const [r] = await ctx.db
      .select()
      .from(reports)
      .where(eq(reports.cycleId, c.id))
      .orderBy(desc(reports.generatedAt))
      .limit(1);
    if (r) out.push({ cycleLabel: c.label, rawText: r.rawText });
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

      const { systemPrompt, userPrompt, missing } = await buildPrompt({
        cycle,
        ceo,
        coachName: coach?.name ?? '(unknown coach)',
        previousReports,
      });

      return { systemPrompt, userPrompt, missing };
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
      const modelId = 'claude-sonnet-4-20250514';
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
});
