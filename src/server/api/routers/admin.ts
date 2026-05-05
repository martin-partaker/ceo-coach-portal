import { z } from 'zod';
import { eq, desc, sql, inArray, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, adminProcedure, protectedProcedure } from '@/server/api/trpc';
import {
  coaches,
  ceos,
  cycles,
  reports,
  ceoEmailAliases,
  rawInputs,
  journalEntries,
  transcripts,
} from '@/db/schema';
import { invalidatePendingSuggestions } from '@/lib/ingestion/triage-suggest';

/**
 * Same scope rule used by roster.*: unscoped means a real super admin who
 * is *not* impersonating a coach (they bypass coach-scope filters); scoped
 * means everyone else — regular coach OR admin actively impersonating a
 * coach. CEO management mutations widened to protectedProcedure use this
 * to require ceo.coachId === ctx.coach.id when scoped.
 */
function isUnscopedAdmin(ctx: {
  realCoach: { isSuperAdmin: boolean } | null;
  isImpersonating: boolean;
}): boolean {
  return !!ctx.realCoach?.isSuperAdmin && !ctx.isImpersonating;
}

export const adminRouter = createTRPCRouter({
  listCoaches: adminProcedure.query(async ({ ctx }) => {
    const allCoaches = await ctx.db
      .select()
      .from(coaches)
      .orderBy(desc(coaches.createdAt));

    const enriched = await Promise.all(
      allCoaches.map(async (coach) => {
        const [countResult] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(ceos)
          .where(eq(ceos.coachId, coach.id));

        return {
          ...coach,
          ceoCount: Number(countResult?.count ?? 0),
        };
      })
    );

    return enriched;
  }),

  createCoach: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        isSuperAdmin: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.email, input.email))
        .limit(1);

      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A coach with this email already exists.',
        });
      }

      // Create coach slot — neonAuthUserId is null until they sign up
      // Default zoom email to their regular email
      const [created] = await ctx.db
        .insert(coaches)
        .values({
          name: input.name,
          email: input.email,
          zoomUserEmail: input.email,
          isSuperAdmin: input.isSuperAdmin ?? false,
        })
        .returning();

      return created;
    }),

  toggleAdmin: adminProcedure
    .input(z.object({ coachId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      if (coach.id === ctx.coach.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot change your own admin status.',
        });
      }

      const [updated] = await ctx.db
        .update(coaches)
        .set({ isSuperAdmin: !coach.isSuperAdmin })
        .where(eq(coaches.id, input.coachId))
        .returning();

      return updated;
    }),

  // Flat list of every CEO across all coaches — for /admin/ceos
  listAllCeos: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        ceo: ceos,
        coach: coaches,
      })
      .from(ceos)
      .innerJoin(coaches, eq(ceos.coachId, coaches.id))
      .orderBy(desc(ceos.createdAt));

    const enriched = await Promise.all(
      rows.map(async ({ ceo, coach }) => {
        const [cycleCountRow] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(cycles)
          .where(eq(cycles.ceoId, ceo.id));

        const [latestCycle] = await ctx.db
          .select({ id: cycles.id, label: cycles.label, periodEnd: cycles.periodEnd })
          .from(cycles)
          .where(eq(cycles.ceoId, ceo.id))
          .orderBy(desc(cycles.periodStart))
          .limit(1);

        let hasReport = false;
        if (latestCycle) {
          const [r] = await ctx.db
            .select({ id: reports.id })
            .from(reports)
            .where(eq(reports.cycleId, latestCycle.id))
            .limit(1);
          hasReport = !!r;
        }

        const aliases = await ctx.db
          .select({ email: ceoEmailAliases.email })
          .from(ceoEmailAliases)
          .where(eq(ceoEmailAliases.ceoId, ceo.id));

        return {
          ceo,
          coach,
          cycleCount: Number(cycleCountRow?.count ?? 0),
          latestCycle: latestCycle ?? null,
          hasReport,
          aliasEmails: aliases.map((a) => a.email),
        };
      })
    );

    return enriched;
  }),

  /* ───────────────────── CEO management ───────────────────── */

  createCeo: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email().nullable().optional(),
        // Optional now — admins can drop a CEO onto the roster without
        // assigning a coach yet; they appear under "Unassigned" until
        // someone reassigns them.
        coachId: z.string().uuid().nullable().optional(),
        tenXGoal: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.coachId) {
        const [coach] = await ctx.db
          .select({ id: coaches.id })
          .from(coaches)
          .where(eq(coaches.id, input.coachId))
          .limit(1);
        if (!coach) throw new TRPCError({ code: 'NOT_FOUND', message: 'Coach not found' });
      }

      const normalizedEmail = input.email ? input.email.toLowerCase().trim() : null;

      // Email collision check (against alias table)
      if (normalizedEmail) {
        const [clash] = await ctx.db
          .select()
          .from(ceoEmailAliases)
          .where(eq(ceoEmailAliases.email, normalizedEmail))
          .limit(1);
        if (clash) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Email already linked to a different CEO.',
          });
        }
      }

      const [created] = await ctx.db
        .insert(ceos)
        .values({
          coachId: input.coachId ?? null,
          name: input.name,
          email: normalizedEmail,
          tenXGoal: input.tenXGoal ?? null,
          tenXGoalUpdatedAt: input.tenXGoal ? new Date() : null,
        })
        .returning();

      // Mirror into alias table for the lookup path
      if (normalizedEmail) {
        await ctx.db
          .insert(ceoEmailAliases)
          .values({ ceoId: created.id, email: normalizedEmail })
          .onConflictDoNothing({ target: ceoEmailAliases.email });
      }

      // New CEO → every pending row's suggestion is potentially stale.
      // Mark them for lazy recompute next time triageQueue is queried.
      await invalidatePendingSuggestions();

      return created;
    }),

  updateCeo: protectedProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        name: z.string().min(1).optional(),
        email: z.string().email().nullable().optional(),
        tenXGoal: z.string().nullable().optional(),
        avatarUrl: z.string().url().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!isUnscopedAdmin(ctx) && ceo.coachId !== ctx.coach.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      const set: Partial<typeof ceos.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.email !== undefined) {
        set.email = input.email ? input.email.toLowerCase().trim() : null;
      }
      if (input.tenXGoal !== undefined) {
        set.tenXGoal = input.tenXGoal;
        set.tenXGoalUpdatedAt = new Date();
      }
      if (input.avatarUrl !== undefined) set.avatarUrl = input.avatarUrl;

      const [updated] = await ctx.db
        .update(ceos)
        .set(set)
        .where(eq(ceos.id, input.ceoId))
        .returning();

      // If email changed, ensure it's in the aliases table
      if (input.email !== undefined && set.email) {
        await ctx.db
          .insert(ceoEmailAliases)
          .values({ ceoId: updated.id, email: set.email })
          .onConflictDoNothing({ target: ceoEmailAliases.email });
        // New alias → suggestions might shift; invalidate.
        await invalidatePendingSuggestions();
      }

      return updated;
    }),

  addCeoAlias: protectedProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        email: z.string().email(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Resolve + ownership-check the CEO up front when scoped.
      const [ownerCeo] = await ctx.db
        .select({ coachId: ceos.coachId })
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ownerCeo) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!isUnscopedAdmin(ctx) && ownerCeo.coachId !== ctx.coach.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      const normalized = input.email.toLowerCase().trim();
      const [existing] = await ctx.db
        .select()
        .from(ceoEmailAliases)
        .where(eq(ceoEmailAliases.email, normalized))
        .limit(1);
      if (existing) {
        if (existing.ceoId === input.ceoId) return existing;
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'That email is already linked to a different CEO.',
        });
      }
      const [created] = await ctx.db
        .insert(ceoEmailAliases)
        .values({ ceoId: input.ceoId, email: normalized })
        .returning();
      // New alias → suggestions might shift; invalidate.
      await invalidatePendingSuggestions();
      return created;
    }),

  removeCeoAlias: protectedProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        email: z.string().email(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const normalized = input.email.toLowerCase().trim();
      // Don't let the operator orphan the CEO from their primary email
      // — the canonical address on the ceos row stays authoritative.
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!isUnscopedAdmin(ctx) && ceo.coachId !== ctx.coach.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (ceo.email === normalized) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'This is the CEO\'s primary email — change the email field first, then remove the old alias.',
        });
      }
      await ctx.db
        .delete(ceoEmailAliases)
        .where(
          and(
            eq(ceoEmailAliases.ceoId, input.ceoId),
            eq(ceoEmailAliases.email, normalized)
          )
        );
      return { ok: true };
    }),

  reassignCeo: adminProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        // Pass null to move the CEO into the "Unassigned" bucket.
        newCoachId: z.string().uuid().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      if (input.newCoachId) {
        const [coach] = await ctx.db
          .select({ id: coaches.id })
          .from(coaches)
          .where(eq(coaches.id, input.newCoachId))
          .limit(1);
        if (!coach) throw new TRPCError({ code: 'NOT_FOUND', message: 'Coach not found' });
      }

      if (ceo.coachId === input.newCoachId) {
        return ceo;
      }

      const [updated] = await ctx.db
        .update(ceos)
        .set({ coachId: input.newCoachId })
        .where(eq(ceos.id, input.ceoId))
        .returning();

      return updated;
    }),

  deleteCeo: protectedProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        // When true, detach raw_inputs (matched/pending_cycle revert to
        // pending_ceo for re-triage) before deleting. Used to dedupe
        // duplicate CEOs without losing their data.
        releaseInputs: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!isUnscopedAdmin(ctx) && ceo.coachId !== ctx.coach.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      let released = 0;

      if (input.releaseInputs) {
        const attached = await ctx.db
          .select({ id: rawInputs.id, matchStatus: rawInputs.matchStatus })
          .from(rawInputs)
          .where(eq(rawInputs.ceoId, input.ceoId));

        if (attached.length > 0) {
          const ids = attached.map((r) => r.id);

          // Reverse projection — these would otherwise cascade-delete via
          // cycles, but we want to free the raw_inputs cleanly.
          await ctx.db
            .delete(journalEntries)
            .where(inArray(journalEntries.sourceRawInputId, ids));
          await ctx.db
            .delete(transcripts)
            .where(inArray(transcripts.sourceRawInputId, ids));

          // Re-triage anything that was attributing to this CEO. Discarded
          // and archived rows keep their status — only their CEO link is
          // cleared so the cascade below doesn't drop them.
          const reTriageIds = attached
            .filter(
              (r) =>
                r.matchStatus === 'matched' ||
                r.matchStatus === 'pending_cycle'
            )
            .map((r) => r.id);

          if (reTriageIds.length > 0) {
            await ctx.db
              .update(rawInputs)
              .set({
                ceoId: null,
                cycleId: null,
                matchStatus: 'pending_ceo',
                matchConfidence: null,
                resolvedAt: null,
                resolvedBy: null,
              })
              .where(inArray(rawInputs.id, reTriageIds));
            released = reTriageIds.length;
          }

          const otherIds = ids.filter((id) => !reTriageIds.includes(id));
          if (otherIds.length > 0) {
            await ctx.db
              .update(rawInputs)
              .set({ ceoId: null, cycleId: null })
              .where(inArray(rawInputs.id, otherIds));
          }
        }
      }

      // Cascade: aliases, cycles, journal_entries, transcripts, action_items,
      // reports, raw_inputs all reference ceos with onDelete: 'cascade'.
      // (When releaseInputs=true, raw_inputs were already detached above.)
      await ctx.db.delete(ceos).where(eq(ceos.id, input.ceoId));
      return { ok: true, released };
    }),

  /* ───────────────────── Coach management ───────────────────── */

  updateCoach: adminProcedure
    .input(
      z.object({
        coachId: z.string().uuid(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        zoomUserEmail: z.string().email().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      const set: Partial<typeof coaches.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.email !== undefined) set.email = input.email.toLowerCase().trim();
      if (input.zoomUserEmail !== undefined) {
        set.zoomUserEmail = input.zoomUserEmail
          ? input.zoomUserEmail.toLowerCase().trim()
          : null;
      }

      const [updated] = await ctx.db
        .update(coaches)
        .set(set)
        .where(eq(coaches.id, input.coachId))
        .returning();
      return updated;
    }),

  deleteCoach: adminProcedure
    .input(z.object({ coachId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      // Refuse to delete a coach who still has CEOs — operator must
      // reassign or delete them first to avoid surprise cascades.
      const [{ count }] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(ceos)
        .where(eq(ceos.coachId, input.coachId));
      const ceoCount = Number(count);
      if (ceoCount > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Coach has ${ceoCount} CEO${ceoCount === 1 ? '' : 's'}. Reassign or delete them first.`,
        });
      }

      if (coach.id === ctx.coach.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You cannot delete your own coach account.',
        });
      }

      await ctx.db.delete(coaches).where(eq(coaches.id, input.coachId));
      return { ok: true };
    }),

  // View-as: get a coach's dashboard data (CEOs with status)
  viewAsCoach: adminProcedure
    .input(z.object({ coachId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      const coachCeos = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.coachId, coach.id))
        .orderBy(desc(ceos.createdAt));

      const enriched = await Promise.all(
        coachCeos.map(async (ceo) => {
          const [latestCycle] = await ctx.db
            .select()
            .from(cycles)
            .where(eq(cycles.ceoId, ceo.id))
            .orderBy(desc(cycles.createdAt))
            .limit(1);

          let hasReport = false;
          if (latestCycle) {
            const [report] = await ctx.db
              .select({ id: reports.id })
              .from(reports)
              .where(eq(reports.cycleId, latestCycle.id))
              .limit(1);
            hasReport = !!report;
          }

          return { ceo, latestCycle: latestCycle ?? null, hasReport };
        })
      );

      return { coach, ceos: enriched };
    }),
});
