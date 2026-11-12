import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createTRPCRouter, adminProcedure } from '@/server/api/trpc';
import {
  auditFeedback,
  transcriptAudits,
  transcripts,
  rawInputs,
  rawInputCeos,
  ceos,
  coaches,
} from '@/db/schema';
import {
  AUDIT_CONTRACT_VERSION,
  FEEDBACK_REASONS,
  FEEDBACK_VERDICTS,
  findingStepKey,
  isAuditResult,
  resolveEvidence,
  type AuditResult,
} from '@/lib/audit/contract';

const feedbackTarget = z.object({
  auditId: z.string().uuid(),
  findingId: z.string().min(1).max(120),
  findingStep: z.string().max(60).nullable(),
});

/**
 * Session quality audits. The verdicts are produced offline by the Python
 * evaluators and loaded by `scripts/import-audits.ts`; nothing here changes
 * one. What a reviewer thinks of a finding is written beside it, in
 * `audit_feedback`, by `setFeedback`.
 *
 * CEO attribution goes through `rawInputCeos`, never
 * `transcripts.authoredByCeoId` — that column is NULL on 40 of 257 rows and a
 * group call has more CEOs than one column can hold. See
 * `attribuzione-ceo-transcript.md`.
 */
export const auditRouter = createTRPCRouter({
  /** One row per audited session, newest audit per transcript. */
  list: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        auditId: transcriptAudits.id,
        transcriptId: transcriptAudits.transcriptId,
        sessionNo: transcriptAudits.sessionNo,
        confidence: transcriptAudits.sessionConfidence,
        confidenceReason: transcriptAudits.sessionConfidenceReason,
        concernCount: transcriptAudits.concernCount,
        reviewCount: transcriptAudits.reviewCount,
        notAssessedCount: transcriptAudits.notAssessedCount,
        criteriaVersion: transcriptAudits.criteriaVersion,
        generatedAt: transcriptAudits.generatedAt,
        familiesExamined: sql<string[]>`
          coalesce(
            array(SELECT jsonb_array_elements_text(
              ${transcriptAudits.resultJson} -> 'familiesExamined')),
            '{}'
          )`,
        /** How many findings of THIS audit the signed-in reviewer has answered. */
        answeredCount: sql<number>`(
          SELECT count(*)::int FROM ${auditFeedback} af
          WHERE af.audit_id = ${transcriptAudits.id}
            AND af.coach_id = ${ctx.coach.id}
        )`,
        title: transcripts.title,
        recordedAt: transcripts.recordedAt,
        hasCueTimes: sql<boolean>`${transcripts.cueTimes} IS NOT NULL`,
        ceoName: ceos.name,
        /**
         * Who coached THIS session, read from the transcript's own speaker
         * label — not the CEO's current coach. CEOs change coach mid-programme
         * (one audited Session 1 was run by a coach the CEO has since left),
         * and a screen that judges a session must not put it under the name
         * of someone who was not in it. Falls back to the current coach only
         * when the audit carries no label.
         */
        coachName: sql<string | null>`coalesce(${transcriptAudits.resultJson} ->> 'coachLabel', ${coaches.name})`,
      })
      .from(transcriptAudits)
      .innerJoin(transcripts, eq(transcripts.id, transcriptAudits.transcriptId))
      .leftJoin(rawInputs, eq(rawInputs.id, transcripts.sourceRawInputId))
      .leftJoin(rawInputCeos, eq(rawInputCeos.rawInputId, rawInputs.id))
      .leftJoin(ceos, eq(ceos.id, rawInputCeos.ceoId))
      .leftJoin(coaches, eq(coaches.id, ceos.coachId))
      .orderBy(desc(transcriptAudits.generatedAt));

    /**
     * One row per session: its newest audit. Rows arrive newest first, so
     * the first one seen for a transcript is the one to keep.
     *
     * Two reasons a transcript shows up more than once. The attribution join
     * fans a group call out into one row per attending CEO. And audits are
     * versioned, never edited in place — every criteria change regenerates
     * them all — so older audits of the same session stay in the table.
     */
    // Every CEO on the recording is named: a session coached with two
    // partners is one session, and showing it under one of them hides the other.
    const names = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.ceoName) continue;
      const set = names.get(r.transcriptId) ?? new Set<string>();
      set.add(r.ceoName);
      names.set(r.transcriptId, set);
    }
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        if (seen.has(r.transcriptId)) return false;
        seen.add(r.transcriptId);
        return true;
      })
      .map((r) => ({
        ...r,
        ceoName: [...(names.get(r.transcriptId) ?? [])].sort().join(' & ') || null,
      }));
  }),

  /**
   * One audit with its quotes already resolved to text and seconds.
   *
   * Resolution happens here, on the server, because it needs the transcript
   * and the cue times and because every consumer must resolve a line the same
   * way. A stale audit is REFUSED rather than rendered: the line indices are
   * valid only for the exact text that was hashed, so if the transcript has
   * changed since, pointing at those lines would quote the wrong words with
   * full confidence.
   */
  byId: adminProcedure
    .input(z.object({ auditId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          audit: transcriptAudits,
          content: transcripts.content,
          cueTimes: transcripts.cueTimes,
          title: transcripts.title,
          recordedAt: transcripts.recordedAt,
          duration: transcripts.duration,
        })
        .from(transcriptAudits)
        .innerJoin(transcripts, eq(transcripts.id, transcriptAudits.transcriptId))
        .where(eq(transcriptAudits.id, input.auditId))
        .limit(1);

      if (!row) return null;

      const result = row.audit.resultJson;
      if (!isAuditResult(result)) {
        return {
          state: 'unreadable' as const,
          reason:
            `This audit was written against contract v${
              (result as { contractVersion?: unknown })?.contractVersion ?? '?'
            }, and this app reads v${AUDIT_CONTRACT_VERSION}. It has to be ` +
            'regenerated. Nothing is shown rather than part of it.',
        };
      }

      const { createHash } = await import('node:crypto');
      const sha = createHash('sha256').update(row.content, 'utf8').digest('hex');
      if (sha !== result.contentSha256) {
        return {
          state: 'stale' as const,
          reason:
            'The transcript has changed since this audit ran. Every quote in it ' +
            'is a line number into the old text, so the quotes would point at ' +
            'the wrong words. Regenerate the audit.',
        };
      }

      const typed: AuditResult = result;

      // Answers given on THIS audit only. An answer to an earlier audit of
      // the same session was about that version's verdict and is not carried
      // over to this one.
      const answers = await ctx.db
        .select({
          findingId: auditFeedback.findingId,
          findingStep: auditFeedback.findingStep,
          verdict: auditFeedback.verdict,
          reason: auditFeedback.reason,
          note: auditFeedback.note,
          coachId: auditFeedback.coachId,
          coachName: coaches.name,
          updatedAt: auditFeedback.updatedAt,
        })
        .from(auditFeedback)
        .innerJoin(coaches, eq(coaches.id, auditFeedback.coachId))
        .where(eq(auditFeedback.auditId, input.auditId));
      const answersFor = (id: string, step: string | null) =>
        answers.filter(
          (a) => a.findingId === id && a.findingStep === findingStepKey(step),
        );

      const findings = typed.findings.map((f) => {
        const all = answersFor(f.id, f.step).map(({ coachId, ...a }) => ({
          ...a,
          mine: coachId === ctx.coach.id,
        }));
        return {
          ...f,
          quotes: f.evidence
            .map((e) => resolveEvidence(row.content, row.cueTimes, e))
            .filter((q): q is { text: string; startSec: number | null } => q !== null),
          feedback: {
            mine: all.find((a) => a.mine) ?? null,
            others: all.filter((a) => !a.mine),
          },
        };
      });

      return {
        state: 'ok' as const,
        audit: {
          id: row.audit.id,
          sessionNo: typed.sessionNo,
          confidence: typed.sessionConfidence,
          confidenceReason: typed.sessionConfidenceReason,
          criteriaVersion: typed.criteriaVersion,
          generatedAt: row.audit.generatedAt,
          coachLabel: typed.coachLabel,
          coachNote: typed.coachNote ?? null,
          totalSec: typed.totalSec,
          /** Empty means NO family was examined — not "examined and clean". */
          familiesExamined: typed.familiesExamined,
          findings,
        },
        transcript: {
          title: row.title,
          recordedAt: row.recordedAt,
          duration: row.duration,
          hasCueTimes: row.cueTimes !== null,
        },
      };
    }),

  /**
   * Record what the signed-in reviewer thinks of one finding. One answer per
   * reviewer per finding per audit; answering again replaces it.
   *
   * The finding has to exist in the audit named. Without that check a stale
   * page, or a finding id from another criteria version, would store an
   * answer to a question this audit never asked.
   */
  setFeedback: adminProcedure
    .input(
      feedbackTarget.extend({
        verdict: z.enum(FEEDBACK_VERDICTS),
        reason: z.enum(FEEDBACK_REASONS).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [audit] = await ctx.db
        .select({ resultJson: transcriptAudits.resultJson })
        .from(transcriptAudits)
        .where(eq(transcriptAudits.id, input.auditId))
        .limit(1);
      if (!audit || !isAuditResult(audit.resultJson)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Audit not found.' });
      }
      const step = findingStepKey(input.findingStep);
      const exists = audit.resultJson.findings.some(
        (f) => f.id === input.findingId && findingStepKey(f.step) === step,
      );
      if (!exists) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That finding is not part of this audit. Reload the page.',
        });
      }

      // A reason explains a disagreement; it means nothing beside "agree".
      const reason = input.verdict === 'disagree' ? (input.reason ?? null) : null;
      const note = input.note?.trim() ? input.note.trim() : null;

      await ctx.db
        .insert(auditFeedback)
        .values({
          auditId: input.auditId,
          findingId: input.findingId,
          findingStep: step,
          verdict: input.verdict,
          reason,
          note,
          coachId: ctx.coach.id,
        })
        .onConflictDoUpdate({
          target: [
            auditFeedback.auditId,
            auditFeedback.findingId,
            auditFeedback.findingStep,
            auditFeedback.coachId,
          ],
          set: { verdict: input.verdict, reason, note, updatedAt: new Date() },
        });
      return { ok: true as const };
    }),

  /** Take back the signed-in reviewer's own answer to one finding. */
  clearFeedback: adminProcedure.input(feedbackTarget).mutation(async ({ ctx, input }) => {
    await ctx.db
      .delete(auditFeedback)
      .where(
        and(
          eq(auditFeedback.auditId, input.auditId),
          eq(auditFeedback.findingId, input.findingId),
          eq(auditFeedback.findingStep, findingStepKey(input.findingStep)),
          eq(auditFeedback.coachId, ctx.coach.id),
        ),
      );
    return { ok: true as const };
  }),
});
