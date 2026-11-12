import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { createTRPCRouter, adminProcedure } from '@/server/api/trpc';
import {
  transcriptAudits,
  transcripts,
  rawInputs,
  rawInputCeos,
  ceos,
  coaches,
} from '@/db/schema';
import {
  AUDIT_CONTRACT_VERSION,
  isAuditResult,
  resolveEvidence,
  type AuditResult,
} from '@/lib/audit/contract';

/**
 * Session quality audits. Read-only in this version: the verdicts are produced
 * offline by the Python evaluators and loaded by `scripts/import-audits.ts`.
 * Agree / Disagree capture is deliberately not here yet.
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
    const seen = new Set<string>();
    return rows.filter((r) => {
      if (seen.has(r.transcriptId)) return false;
      seen.add(r.transcriptId);
      return true;
    });
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
      const findings = typed.findings.map((f) => ({
        ...f,
        quotes: f.evidence
          .map((e) => resolveEvidence(row.content, row.cueTimes, e))
          .filter((q): q is { text: string; startSec: number | null } => q !== null),
      }));

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
});
