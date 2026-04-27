import { db } from '@/db';
import { rawInputs, type TallyForm } from '@/db/schema';
import type { TallySubmission, TallyQuestion } from '@/lib/tally/client';
import {
  findResponseAnswer,
  answerToString,
  findClientNameQuestionId,
} from '@/lib/tally/heuristics';
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

  // Detect coach-authored submissions: any @partaker.com submitter is a coach
  // filling in a form ABOUT a client. The actual subject is in a
  // "Client's name" / "CEO's name" field on the form.
  const submitterIsCoach = !!(rawEmail && isInternalEmail(rawEmail));
  const clientQid = submitterIsCoach ? findClientNameQuestionId(questions) : null;
  const clientName = clientQid
    ? answerToString(findResponseAnswer(submission.responses, clientQid))
    : null;
  const coachInfo = submitterIsCoach
    ? { email: rawEmail, name: rawName ?? null }
    : null;

  // For matching purposes:
  //  - Coach submissions match by the *client* name, ignoring submitter email
  //  - Regular submissions match by the submitter's email + name as before
  const effectiveEmail = submitterIsCoach ? null : rawEmail;
  const effectiveName = submitterIsCoach ? clientName : rawName;

  let matchStatus: TallyIngestOutcome = 'matched';
  let ceoId: string | null = null;
  let cycleId: string | null = null;
  let coachId: string | null = null;
  let matchConfidence: number | null = 100;
  // Always retain submitter identity in matchCandidates so the triage UI can
  // show "what we received" later. For coach-authored rows we add a
  // submittedByCoach marker so the UI can frame "Submitted by [coach] about
  // [client]".
  let matchCandidates: unknown =
    effectiveEmail || effectiveName || coachInfo
      ? {
          email: effectiveEmail ?? null,
          name: effectiveName ?? null,
          submittedByCoach: coachInfo,
        }
      : null;

  // Only treat as test data if the NAME literally contains "test"
  // (e.g. "Megan test"). @partaker.com alone is no longer auto-discard.
  const looksLikeTest = rawName?.toLowerCase().includes('test');

  if (looksLikeTest) {
    matchStatus = 'discarded';
    matchConfidence = null;
  } else if (submitterIsCoach && !clientName) {
    // Coach submitted but we couldn't find a client name — operator must triage.
    matchStatus = 'pending_ceo';
    matchConfidence = null;
    matchCandidates = {
      reason: 'coach_submitted_no_client',
      email: null,
      name: null,
      submittedByCoach: coachInfo,
    };
  } else if (submitterIsCoach && clientName) {
    // Coach submission with a client name → match by name only.
    // Name match is still ambiguous, so this lands in pending_ceo for the
    // operator to confirm via the triage suggester (which scores by name).
    matchStatus = 'pending_ceo';
    matchConfidence = null;
    matchCandidates = {
      reason: 'coach_submitted',
      email: null,
      name: clientName,
      submittedByCoach: coachInfo,
    };
  } else if (!effectiveEmail) {
    matchStatus = 'pending_ceo';
    matchConfidence = null;
    matchCandidates = { reason: 'no_email_in_submission', name: effectiveName };
  } else {
    const normalizedEmail = normalizeEmail(effectiveEmail);
    const ceo = await findCeoByEmail(normalizedEmail);
    if (!ceo) {
      matchStatus = 'pending_ceo';
      matchConfidence = null;
      matchCandidates = { reason: 'unknown_email', email: normalizedEmail, name: effectiveName };
    } else {
      // Email exact match → identity 100% certain. Auto-resolve cycle.
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
