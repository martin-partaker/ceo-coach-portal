import { db } from '@/db';
import { rawInputs, type TallyForm } from '@/db/schema';
import type { TallySubmission, TallyQuestion } from '@/lib/tally/client';
import { findResponseAnswer, answerToString } from '@/lib/tally/heuristics';
import { renderSubmissionAsText } from '@/lib/tally/render';
import { findCeoByEmail, isInternalEmail, normalizeEmail } from './identity';
import { ensureCycleForCeoAndDate } from './match-cycle';
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
  // Always retain submitter identity in matchCandidates so the triage UI can
  // show "what we received" later even after the match resolved. The trade-off:
  // matchCandidates becomes a dual-purpose blob (submitter info always +
  // pending-reason metadata when applicable) but the schema doesn't change.
  let matchCandidates: unknown = rawEmail || rawName ? { email: rawEmail ?? null, name: rawName ?? null } : null;

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
      // Email exact match → identity is 100% certain. Auto-resolve cycle
      // (creating a monthly default if the CEO has no cycles yet) so the row
      // never appears in manual triage. The submitter has already told us
      // who they are.
      ceoId = ceo.id;
      coachId = ceo.coachId;
      const cycleMatch = await ensureCycleForCeoAndDate({ ceoId: ceo.id, occurredAt });
      cycleId = cycleMatch.cycleId;
      matchConfidence = cycleMatch.confident ? 100 : 75;
    }
  }

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
    .onConflictDoNothing({ target: [rawInputs.source, rawInputs.externalId] })
    .returning({ id: rawInputs.id });

  if (!inserted) return 'duplicate';
  const insertedId = inserted.id;

  if (insertedId && matchStatus === 'matched') {
    if (cycleId || formRow.contentType === 'intake' || formRow.contentType === 'goal_worksheet') {
      await projectRawInput(insertedId);
    }
  }

  return matchStatus;
}
