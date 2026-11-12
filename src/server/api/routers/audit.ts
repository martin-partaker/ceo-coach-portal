import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
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
  splitSpeaker,
  transcriptLines,
  zoomRecordingUrl,
  type AuditResult,
} from '@/lib/audit/contract';
import {
  FEEDBACK_WITHDRAWN,
  feedbackFor,
  type EarlierAnswer,
  type StoredAnswer,
} from '@/lib/audit/feedback-carry';
import { createHash } from 'node:crypto';

/**
 * Why an audit cannot be shown, if it cannot. Every quote is a line number
 * into the transcript as it was when the audit ran: against another contract
 * or a changed transcript the numbers would point at the wrong words, so
 * nothing is shown rather than part of it.
 */
function unusable(
  result: unknown,
  content: string,
): { state: 'unreadable' | 'stale'; reason: string } | null {
  if (!isAuditResult(result)) {
    return {
      state: 'unreadable',
      reason:
        `This audit was written against contract v${
          (result as { contractVersion?: unknown })?.contractVersion ?? '?'
        }, and this app reads v${AUDIT_CONTRACT_VERSION}. It has to be ` +
        'regenerated. Nothing is shown rather than part of it.',
    };
  }
  const sha = createHash('sha256').update(content, 'utf8').digest('hex');
  if (sha !== result.contentSha256) {
    return {
      state: 'stale',
      reason:
        'The transcript has changed since this audit ran. Every quote in it ' +
        'is a line number into the old text, so the quotes would point at ' +
        'the wrong words. Regenerate the audit.',
    };
  }
  return null;
}

/** Where Zoom keeps the recording, when we were given a link for it. */
const SHARE_URL = sql<string | null>`${rawInputs.payloadJson} -> 'meeting' ->> 'share_url'`;

/**
 * Names for the cohort table where a finding's own name cannot serve: these
 * change their wording with their verdict, or carry a number in it.
 */
const COHORT_LABEL: Record<string, string> = {
  'goal.hypothesis': 'A goal is stated with a figure',
  'goal.challenged': 'The coach questions the goal figure',
  'goal.tests': 'The outline’s three tests of a true 10x goal are worked',
  'lang.scaleos': 'ScaleOS language is used by the coach',
  'read.reality': 'The coach explores where the business stands',
  'read.order': 'Business reality comes before the goal',
  'read.perspective': 'The coach gives a view of their own (3.1c, to confirm)',
  'read.not_run': 'Business reality, order and perspective: read by a model',
  'conduct.outside_engagement': 'No work with the CEO outside the programme',
  'conduct.own_services': 'No offering of the coach’s own services',
};

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
            AND af.verdict <> ${FEEDBACK_WITHDRAWN}
        )`,
        /**
         * Findings of this audit she has not answered here but did answer on
         * an earlier audit of the same recording — her latest word on each,
         * unless that was to take it back. Whether each still stands is
         * decided on the session's page, where the two versions are compared;
         * this is only "there are answers of yours waiting in there".
         */
        carriedCount: sql<number>`(
          SELECT count(*)::int FROM (
            SELECT DISTINCT ON (af.finding_id, af.finding_step) af.verdict
            FROM audit_feedback af
            JOIN transcript_audits pa ON pa.id = af.audit_id
            WHERE pa.transcript_id = ${transcriptAudits.transcriptId}
              AND pa.generated_at < ${transcriptAudits.generatedAt}
              AND af.coach_id = ${ctx.coach.id}
              AND NOT EXISTS (
                SELECT 1 FROM audit_feedback cur
                WHERE cur.audit_id = ${transcriptAudits.id}
                  AND cur.coach_id = af.coach_id
                  AND cur.finding_id = af.finding_id
                  AND cur.finding_step = af.finding_step
              )
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(${transcriptAudits.resultJson} -> 'findings') f
                WHERE f ->> 'id' = af.finding_id
                  AND coalesce(f ->> 'step', '') = af.finding_step
              )
            ORDER BY af.finding_id, af.finding_step, pa.generated_at DESC, af.updated_at DESC
          ) latest
          WHERE latest.verdict <> ${FEEDBACK_WITHDRAWN}
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
          shareUrl: SHARE_URL,
        })
        .from(transcriptAudits)
        .innerJoin(transcripts, eq(transcripts.id, transcriptAudits.transcriptId))
        .leftJoin(rawInputs, eq(rawInputs.id, transcripts.sourceRawInputId))
        .where(eq(transcriptAudits.id, input.auditId))
        .limit(1);

      if (!row) return null;

      const result = row.audit.resultJson;
      const refused = unusable(result, row.content);
      if (refused) return refused;

      const typed = result as AuditResult;

      // Answers stored on THIS audit, and the same reviewers' answers on
      // earlier audits of the same recording. Nothing is copied forward: an
      // earlier answer is shown as carried over, and only stands if the
      // finding is still the same claim (see feedback-carry.ts).
      const answerColumns = {
        findingId: auditFeedback.findingId,
        findingStep: auditFeedback.findingStep,
        verdict: auditFeedback.verdict,
        reason: auditFeedback.reason,
        note: auditFeedback.note,
        coachId: auditFeedback.coachId,
        coachName: coaches.name,
        updatedAt: auditFeedback.updatedAt,
      };
      const current: StoredAnswer[] = await ctx.db
        .select(answerColumns)
        .from(auditFeedback)
        .innerJoin(coaches, eq(coaches.id, auditFeedback.coachId))
        .where(eq(auditFeedback.auditId, input.auditId));

      const earlier: EarlierAnswer[] = await ctx.db
        .select({
          ...answerColumns,
          auditId: transcriptAudits.id,
          criteriaVersion: transcriptAudits.criteriaVersion,
          generatedAt: transcriptAudits.generatedAt,
        })
        .from(auditFeedback)
        .innerJoin(transcriptAudits, eq(transcriptAudits.id, auditFeedback.auditId))
        .innerJoin(coaches, eq(coaches.id, auditFeedback.coachId))
        .where(
          and(
            eq(transcriptAudits.transcriptId, row.audit.transcriptId),
            lt(transcriptAudits.generatedAt, row.audit.generatedAt),
          ),
        );

      // Only the earlier audits somebody answered on, which is few.
      const earlierIds = [...new Set(earlier.map((a) => a.auditId))];
      const earlierAudits = new Map<string, AuditResult | null>();
      if (earlierIds.length > 0) {
        const olds = await ctx.db
          .select({ id: transcriptAudits.id, resultJson: transcriptAudits.resultJson })
          .from(transcriptAudits)
          .where(inArray(transcriptAudits.id, earlierIds));
        for (const o of olds) {
          earlierAudits.set(o.id, isAuditResult(o.resultJson) ? o.resultJson : null);
        }
      }

      const findings = typed.findings.map((f) => ({
        ...f,
        // Each quote keeps its line numbers: they are the link from the
        // quote to its place in the transcript page.
        quotes: f.evidence.flatMap((e) => {
          const q = resolveEvidence(row.content, row.cueTimes, e);
          return q ? [{ ...q, line: e.line, lineEnd: e.lineEnd ?? null }] : [];
        }),
        feedback: feedbackFor({
          finding: f,
          viewerId: ctx.coach.id,
          contentSha256: typed.contentSha256,
          current,
          earlier,
          earlierAudits,
        }),
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
          recordingUrl: zoomRecordingUrl(row.shareUrl),
        },
      };
    }),

  /**
   * The whole transcript of an audited session, line by line, with the
   * passages the audit quotes marked.
   *
   * This is where a quote's minute leads. Zoom has no link that opens a
   * recording at a given moment, so the minute cannot take the reviewer into
   * the video; it takes her to the words in their place, with what was said
   * before and after, and the recording is one link away with the time in
   * front of her.
   *
   * Keyed by the audit, not the transcript: the line numbers in a link are
   * that audit's, and the same refusals apply as on the audit itself.
   */
  transcript: adminProcedure
    .input(z.object({ auditId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          resultJson: transcriptAudits.resultJson,
          content: transcripts.content,
          cueTimes: transcripts.cueTimes,
          title: transcripts.title,
          recordedAt: transcripts.recordedAt,
          shareUrl: SHARE_URL,
        })
        .from(transcriptAudits)
        .innerJoin(transcripts, eq(transcripts.id, transcriptAudits.transcriptId))
        .leftJoin(rawInputs, eq(rawInputs.id, transcripts.sourceRawInputId))
        .where(eq(transcriptAudits.id, input.auditId))
        .limit(1);

      if (!row) return null;
      const refused = unusable(row.resultJson, row.content);
      if (refused) return refused;
      const audit = row.resultJson as AuditResult;

      const raw = transcriptLines(row.content);
      const secs = row.cueTimes ? row.cueTimes.split(',') : null;
      const lines = raw.map((l, i) => {
        const sec = secs?.[i] === undefined ? Number.NaN : Number.parseInt(secs[i], 10);
        return { ...splitSpeaker(l), sec: Number.isNaN(sec) ? null : sec };
      });

      // Every passage the audit quotes, so the reader can see the other
      // moments it relied on, and which finding each one belongs to.
      const cited = audit.findings.flatMap((f) =>
        f.evidence
          .filter((e) => resolveEvidence(row.content, row.cueTimes, e) !== null)
          .map((e) => ({
            from: e.line,
            to: e.lineEnd ?? e.line,
            step: f.step,
            name: f.name,
          })),
      );

      return {
        state: 'ok' as const,
        title: row.title,
        recordedAt: row.recordedAt,
        hasCueTimes: row.cueTimes !== null,
        recordingUrl: zoomRecordingUrl(row.shareUrl),
        lines,
        cited,
      };
    }),

  /**
   * The same findings, counted across every audited session.
   *
   * A finding that shows up on most sessions is not about a coach: it is
   * about the programme, or about how the coaches were trained. Read one
   * session at a time it turns into wallpaper — the reviewer meets it thirty
   * times and stops seeing it. Counted once, and split by coach, it says what
   * has to be taught to everyone and what has to be said to one person.
   *
   * No new data: this is the newest audit of each recording, aggregated. Only
   * sessions that were actually audited are counted; the ones we could not
   * place are reported as a number, never folded into "nothing found".
   */
  cohort: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        auditId: transcriptAudits.id,
        transcriptId: transcriptAudits.transcriptId,
        criteriaVersion: transcriptAudits.criteriaVersion,
        resultJson: transcriptAudits.resultJson,
        ceoName: ceos.name,
        currentCoach: coaches.name,
      })
      .from(transcriptAudits)
      .innerJoin(transcripts, eq(transcripts.id, transcriptAudits.transcriptId))
      .leftJoin(rawInputs, eq(rawInputs.id, transcripts.sourceRawInputId))
      .leftJoin(rawInputCeos, eq(rawInputCeos.rawInputId, rawInputs.id))
      .leftJoin(ceos, eq(ceos.id, rawInputCeos.ceoId))
      .leftJoin(coaches, eq(coaches.id, ceos.coachId))
      // Newest audit per recording, decided in SQL: every criteria change
      // regenerates all audits, and loading every version's JSON to throw
      // most of it away would grow without bound.
      .where(
        sql`${transcriptAudits.generatedAt} = (
          SELECT max(x.generated_at) FROM transcript_audits x
          WHERE x.transcript_id = ${transcriptAudits.transcriptId}
        )`,
      );

    // A recording coached with two partners arrives as two rows.
    const byTranscript = new Map<
      string,
      { auditId: string; version: string; result: unknown; ceos: Set<string>; currentCoach: string | null }
    >();
    for (const r of rows) {
      const s =
        byTranscript.get(r.transcriptId) ??
        { auditId: r.auditId, version: r.criteriaVersion, result: r.resultJson,
          ceos: new Set<string>(), currentCoach: r.currentCoach };
      if (r.ceoName) s.ceos.add(r.ceoName);
      byTranscript.set(r.transcriptId, s);
    }

    type Tone = 'ok' | 'review' | 'concern' | 'notAssessed';
    const zero = () => ({ ok: 0, review: 0, concern: 0, notAssessed: 0 });
    type Row = {
      key: string; id: string; step: string | null; family: string; readBy: string | null;
      names: Map<string, number>; okNames: Map<string, number>;
      counts: Record<Tone, number>;
      byCoach: Map<string, Record<Tone, number>>;
      sessions: { auditId: string; who: string; coach: string; tone: Tone }[];
    };
    const table = new Map<string, Row>();
    const order: string[] = [];
    const coachSessions = new Map<string, number>();
    const versions = new Set<string>();
    let sessionCount = 0;
    let notPlaced = 0;
    let unreadable = 0;

    for (const s of byTranscript.values()) {
      if (!isAuditResult(s.result)) { unreadable += 1; continue; }
      const audit: AuditResult = s.result;
      if (audit.familiesExamined.length === 0) { notPlaced += 1; continue; }
      sessionCount += 1;
      versions.add(s.version);
      const coach =
        (audit.coachLabel ?? s.currentCoach ?? 'Unknown coach').split(/\s*[,|(]/)[0].trim();
      coachSessions.set(coach, (coachSessions.get(coach) ?? 0) + 1);
      const who = [...s.ceos].sort().join(' & ') || 'Unattributed CEO';

      for (const f of audit.findings) {
        const key = `${f.id}|${findingStepKey(f.step)}`;
        let row = table.get(key);
        if (!row) {
          row = { key, id: f.id, step: f.step, family: f.family, readBy: f.readBy ?? null,
                  names: new Map(), okNames: new Map(), counts: zero(),
                  byCoach: new Map(), sessions: [] };
          table.set(key, row);
          order.push(key);
        }
        const tone: Tone = f.notAssessed ? 'notAssessed' : f.verdict;
        row.counts[tone] += 1;
        const c = row.byCoach.get(coach) ?? zero();
        c[tone] += 1;
        row.byCoach.set(coach, c);
        row.names.set(f.name, (row.names.get(f.name) ?? 0) + 1);
        if (tone === 'ok') row.okNames.set(f.name, (row.okNames.get(f.name) ?? 0) + 1);
        row.sessions.push({ auditId: s.auditId, who, coach, tone });
      }
    }

    const commonest = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const shaped = order.map((k) => {
      const r = table.get(k)!;
      return {
        key: r.key, id: r.id, step: r.step, family: r.family, readBy: r.readBy,
        // What the criterion is called when it is met, if it ever is; several
        // findings change their name with their verdict.
        label: COHORT_LABEL[r.id] ?? commonest(r.okNames) ?? commonest(r.names) ?? r.id,
        counts: r.counts,
        notRaised: sessionCount - r.sessions.length,
        byCoach: [...r.byCoach.entries()]
          .map(([coach, counts]) => ({ coach, counts, sessions: coachSessions.get(coach) ?? 0 }))
          .sort((a, b) => a.coach.localeCompare(b.coach)),
        sessions: r.sessions.sort((a, b) => a.who.localeCompare(b.who)),
      };
    });

    return {
      sessionCount,
      notPlaced,
      unreadable,
      versions: [...versions].sort(),
      coaches: [...coachSessions.entries()]
        .map(([name, sessions]) => ({ name, sessions }))
        .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)),
      // The outline's steps, in the outline's order.
      steps: shaped.filter((r) => r.family === 'A'),
      // Everything else, what most needs a look first.
      findings: shaped
        .filter((r) => r.family !== 'A')
        .sort(
          (a, b) =>
            b.counts.concern + b.counts.review - (a.counts.concern + a.counts.review) ||
            a.label.localeCompare(b.label),
        ),
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

  /**
   * Take back the signed-in reviewer's own answer to one finding.
   *
   * If an earlier answer of hers to the same finding would otherwise be
   * carried forward onto this audit, removing the row is not enough — the old
   * answer would simply reappear. In that case a withdrawal is stored on this
   * audit instead, which says "no answer here, and do not bring the old one
   * forward". The earlier answer itself is left where it was given.
   */
  clearFeedback: adminProcedure.input(feedbackTarget).mutation(async ({ ctx, input }) => {
    const step = findingStepKey(input.findingStep);
    const [audit] = await ctx.db
      .select({
        transcriptId: transcriptAudits.transcriptId,
        generatedAt: transcriptAudits.generatedAt,
      })
      .from(transcriptAudits)
      .where(eq(transcriptAudits.id, input.auditId))
      .limit(1);
    if (!audit) throw new TRPCError({ code: 'NOT_FOUND', message: 'Audit not found.' });

    const [previous] = await ctx.db
      .select({ verdict: auditFeedback.verdict })
      .from(auditFeedback)
      .innerJoin(transcriptAudits, eq(transcriptAudits.id, auditFeedback.auditId))
      .where(
        and(
          eq(transcriptAudits.transcriptId, audit.transcriptId),
          lt(transcriptAudits.generatedAt, audit.generatedAt),
          eq(auditFeedback.findingId, input.findingId),
          eq(auditFeedback.findingStep, step),
          eq(auditFeedback.coachId, ctx.coach.id),
        ),
      )
      .orderBy(desc(transcriptAudits.generatedAt), desc(auditFeedback.updatedAt))
      .limit(1);

    if (previous && previous.verdict !== FEEDBACK_WITHDRAWN) {
      await ctx.db
        .insert(auditFeedback)
        .values({
          auditId: input.auditId,
          findingId: input.findingId,
          findingStep: step,
          verdict: FEEDBACK_WITHDRAWN,
          reason: null,
          note: null,
          coachId: ctx.coach.id,
        })
        .onConflictDoUpdate({
          target: [
            auditFeedback.auditId,
            auditFeedback.findingId,
            auditFeedback.findingStep,
            auditFeedback.coachId,
          ],
          set: { verdict: FEEDBACK_WITHDRAWN, reason: null, note: null, updatedAt: new Date() },
        });
      return { ok: true as const };
    }

    await ctx.db
      .delete(auditFeedback)
      .where(
        and(
          eq(auditFeedback.auditId, input.auditId),
          eq(auditFeedback.findingId, input.findingId),
          eq(auditFeedback.findingStep, step),
          eq(auditFeedback.coachId, ctx.coach.id),
        ),
      );
    return { ok: true as const };
  }),
});
