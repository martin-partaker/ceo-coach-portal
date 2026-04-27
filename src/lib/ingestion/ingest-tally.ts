import 'server-only';
import { db } from '@/db';
import { rawInputs, type TallyForm } from '@/db/schema';
import type { TallySubmission, TallyQuestion } from '@/lib/tally/client';
import { findResponseAnswer, answerToString } from '@/lib/tally/heuristics';
import { renderSubmissionAsText } from '@/lib/tally/render';
import { findCeoByEmail, isInternalEmail, normalizeEmail } from './identity';
import { findCycleForOccurredAt } from './match-cycle';
import { projectRawInput } from './project';

export type TallyIngestOutcome =
  | 'matched'
  | 'pending_ceo'
  | 'pending_cycle'
  | 'discarded'
  | 'duplicate';

export async function ingestTallySubmission(args: {
  formRow: TallyForm;
  submission: TallySubmission;
  questions: TallyQuestion[];
  emailQid: string | null;
  nameQid: string | null;
}): Promise<TallyIngestOutcome> {
  const { formRow, submission, questions, emailQid, nameQid } = args;

  const rawEmail = answerToString(findResponseAnswer(submission.responses, emailQid));
  const rawName = answerToString(findResponseAnswer(submission.responses, nameQid));
  const occurredAt = new Date(submission.submittedAt);
  const textContent = renderSubmissionAsText(questions, submission);

  let matchStatus: TallyIngestOutcome = 'matched';
  let ceoId: string | null = null;
  let cycleId: string | null = null;
  let coachId: string | null = null;
  let matchConfidence: number | null = 100;
  let matchCandidates: unknown = null;

  const looksLikeTest =
    rawName?.toLowerCase().includes('test') || (rawEmail && isInternalEmail(rawEmail));

  if (looksLikeTest) {
    matchStatus = 'discarded';
    matchConfidence = null;
  } else if (!rawEmail) {
    matchStatus = 'pending_ceo';
    matchConfidence = null;
    matchCandidates = { reason: 'no_email_in_submission', name: rawName };
  } else {
    const normalizedEmail = normalizeEmail(rawEmail);
    const ceo = await findCeoByEmail(normalizedEmail);
    if (!ceo) {
      matchStatus = 'pending_ceo';
      matchConfidence = null;
      matchCandidates = { reason: 'unknown_email', email: normalizedEmail, name: rawName };
    } else {
      ceoId = ceo.id;
      coachId = ceo.coachId;
      const cycleMatch = await findCycleForOccurredAt({ ceoId: ceo.id, occurredAt });
      if (!cycleMatch) {
        matchStatus = 'pending_cycle';
        matchConfidence = 100;
      } else {
        cycleId = cycleMatch.cycleId;
        matchConfidence = cycleMatch.confident ? 100 : 75;
      }
    }
  }

  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(rawInputs)
      .values({
        ceoId,
        cycleId,
        coachId,
        source: 'tally',
        contentType: formRow.contentType,
        externalId: submission.id,
        occurredAt,
        payloadJson: submission as unknown as object,
        textContent,
        matchStatus,
        matchConfidence,
        matchCandidates: matchCandidates as object | null,
      })
      .returning({ id: rawInputs.id });
    insertedId = inserted?.id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('raw_inputs_source_extid_idx') || msg.includes('duplicate key')) {
      return 'duplicate';
    }
    throw err;
  }

  if (insertedId && matchStatus === 'matched') {
    if (cycleId || formRow.contentType === 'intake' || formRow.contentType === 'goal_worksheet') {
      await projectRawInput(insertedId);
    }
  }

  return matchStatus;
}
