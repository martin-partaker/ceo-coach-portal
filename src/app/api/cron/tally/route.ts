import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { rawInputs, ingestionCursors, tallyForms } from '@/db/schema';
import {
  listSubmissionsSince,
  getFormQuestions,
  type TallySubmission,
  type TallyQuestion,
} from '@/lib/tally/client';
import { getActiveTallyForms } from '@/lib/tally/registry';
import { inferIdentityFields, findResponseAnswer, answerToString } from '@/lib/tally/heuristics';
import { renderSubmissionAsText } from '@/lib/tally/render';
import { findCeoByEmail, isInternalEmail, normalizeEmail } from '@/lib/ingestion/identity';
import { findCycleForOccurredAt } from '@/lib/ingestion/match-cycle';
import { projectRawInput } from '@/lib/ingestion/project';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${expected}`;
}

interface FormResult {
  formId: string;
  ingested: number;
  matched: number;
  pendingCeo: number;
  pendingCycle: number;
  discarded: number;
  duplicates: number;
  errors: number;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const forms = await getActiveTallyForms();
  const results: FormResult[] = [];

  for (const form of forms) {
    const result: FormResult = {
      formId: form.formId,
      ingested: 0,
      matched: 0,
      pendingCeo: 0,
      pendingCycle: 0,
      discarded: 0,
      duplicates: 0,
      errors: 0,
    };

    try {
      const cursorSource = `tally:${form.formId}`;
      const [cursorRow] = await db
        .select()
        .from(ingestionCursors)
        .where(eq(ingestionCursors.source, cursorSource))
        .limit(1);

      const sinceId = cursorRow?.cursor ?? null;
      const { submissions, questions } = await listSubmissionsSince(form.formId, sinceId);

      // Identity-field discovery: prefer admin overrides, fall back to heuristic.
      const heuristic = inferIdentityFields(questions);
      const emailQid = form.emailQuestionId ?? heuristic.emailQuestionId;
      const nameQid = form.nameQuestionId ?? heuristic.nameQuestionId;

      // Process oldest first so cursor advances correctly if we crash mid-loop.
      const orderedSubs = [...submissions].reverse();

      for (const sub of orderedSubs) {
        try {
          const outcome = await ingestSubmission({
            formRow: form,
            submission: sub,
            questions,
            emailQid,
            nameQid,
          });
          result.ingested++;
          if (outcome === 'duplicate') result.duplicates++;
          else if (outcome === 'matched') result.matched++;
          else if (outcome === 'pending_ceo') result.pendingCeo++;
          else if (outcome === 'pending_cycle') result.pendingCycle++;
          else if (outcome === 'discarded') result.discarded++;
        } catch (err) {
          result.errors++;
          console.error(`Tally ingest error (${form.formId}/${sub.id}):`, err);
        }
      }

      // Cursor = newest seen submission ID (top of the list)
      const newestId = submissions[0]?.id ?? sinceId;
      if (newestId) {
        await db
          .insert(ingestionCursors)
          .values({
            source: cursorSource,
            cursor: newestId,
            lastRunAt: new Date(),
            lastSuccessAt: new Date(),
            lastError: null,
          })
          .onConflictDoUpdate({
            target: ingestionCursors.source,
            set: {
              cursor: newestId,
              lastRunAt: new Date(),
              lastSuccessAt: new Date(),
              lastError: null,
            },
          });
      }
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Tally form ${form.formId} failed:`, err);
      await db
        .insert(ingestionCursors)
        .values({
          source: `tally:${form.formId}`,
          cursor: '',
          lastRunAt: new Date(),
          lastError: msg,
        })
        .onConflictDoUpdate({
          target: ingestionCursors.source,
          set: { lastRunAt: new Date(), lastError: msg },
        });
    }

    results.push(result);
  }

  return NextResponse.json({ results });
}

type Outcome = 'matched' | 'pending_ceo' | 'pending_cycle' | 'discarded' | 'duplicate';

async function ingestSubmission(args: {
  formRow: typeof tallyForms.$inferSelect;
  submission: TallySubmission;
  questions: TallyQuestion[];
  emailQid: string | null;
  nameQid: string | null;
}): Promise<Outcome> {
  const { formRow, submission, questions, emailQid, nameQid } = args;

  const rawEmail = answerToString(findResponseAnswer(submission.responses, emailQid));
  const rawName = answerToString(findResponseAnswer(submission.responses, nameQid));
  const occurredAt = new Date(submission.submittedAt);
  const textContent = renderSubmissionAsText(questions, submission);

  // Discard heuristics
  let matchStatus: Outcome = 'matched';
  let ceoId: string | null = null;
  let cycleId: string | null = null;
  let coachId: string | null = null;
  let matchConfidence: number | null = 100;
  let matchCandidates: unknown = null;

  const looksLikeTest =
    rawName?.toLowerCase().includes('test') ||
    (rawEmail && isInternalEmail(rawEmail));

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
    // Unique violation on (source, external_id) → already ingested
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('raw_inputs_source_extid_idx') || msg.includes('duplicate key')) {
      return 'duplicate';
    }
    throw err;
  }

  // Project to typed tables for matched rows with a cycle (or for content
  // types like intake/goal_worksheet that don't need a cycle).
  if (insertedId && matchStatus === 'matched') {
    if (cycleId || formRow.contentType === 'intake' || formRow.contentType === 'goal_worksheet') {
      await projectRawInput(insertedId);
    }
  }

  return matchStatus;
}
