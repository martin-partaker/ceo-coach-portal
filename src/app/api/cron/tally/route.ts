import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { ingestionCursors } from '@/db/schema';
import { listSubmissionsSince } from '@/lib/tally/client';
import { getActiveTallyForms } from '@/lib/tally/registry';
import { inferIdentityFields } from '@/lib/tally/heuristics';
import { ingestTallySubmission } from '@/lib/ingestion/ingest-tally';

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
          const outcome = await ingestTallySubmission({
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
