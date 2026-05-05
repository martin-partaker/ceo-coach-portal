import { NextResponse } from 'next/server';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { coaches, ingestionCursors } from '@/db/schema';
import { listAllRecordingsForCoach } from '@/lib/zoom/client';
import { ingestZoomMeeting } from '@/lib/ingestion/ingest-zoom';
import { INGESTION_CONFIG } from '@/lib/ingestion/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${expected}`;
}

interface CoachResult {
  coachId: string;
  zoomEmail: string;
  meetings: number;
  ingested: number;
  matched: number;
  pendingCeo: number;
  discarded: number;
  duplicates: number;
  errors: number;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const coachRows = await db
    .select({ id: coaches.id, zoomUserEmail: coaches.zoomUserEmail })
    .from(coaches)
    .where(isNotNull(coaches.zoomUserEmail));

  const results: CoachResult[] = [];

  for (const coach of coachRows) {
    const zoomEmail = coach.zoomUserEmail!;
    const result: CoachResult = {
      coachId: coach.id,
      zoomEmail,
      meetings: 0,
      ingested: 0,
      matched: 0,
      pendingCeo: 0,
      discarded: 0,
      duplicates: 0,
      errors: 0,
    };

    try {
      const cursorSource = `zoom:coach:${coach.id}`;
      const [cursorRow] = await db
        .select()
        .from(ingestionCursors)
        .where(eq(ingestionCursors.source, cursorSource))
        .limit(1);

      const now = new Date();
      const overlapMs = INGESTION_CONFIG.zoomOverlapHours * 60 * 60 * 1000;
      const fromDate = cursorRow
        ? new Date(new Date(cursorRow.cursor).getTime() - overlapMs)
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const meetings = await listAllRecordingsForCoach(zoomEmail, fromDate, now);
      result.meetings = meetings.length;

      for (const meeting of meetings) {
        try {
          const outcome = await ingestZoomMeeting({
            coachId: coach.id,
            zoomEmail,
            meeting,
          });
          result.ingested++;
          if (outcome === 'duplicate') result.duplicates++;
          else if (outcome === 'matched') result.matched++;
          else if (outcome === 'pending_ceo') result.pendingCeo++;
          else if (outcome === 'discarded') result.discarded++;
        } catch (err) {
          result.errors++;
          console.error(`Zoom ingest error (${coach.id}/${meeting.uuid}):`, err);
        }
      }

      await db
        .insert(ingestionCursors)
        .values({
          source: cursorSource,
          cursor: now.toISOString(),
          lastRunAt: now,
          lastSuccessAt: now,
          lastError: null,
        })
        .onConflictDoUpdate({
          target: ingestionCursors.source,
          set: {
            cursor: now.toISOString(),
            lastRunAt: now,
            lastSuccessAt: now,
            lastError: null,
          },
        });
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Zoom coach ${coach.id} failed:`, err);
      await db
        .insert(ingestionCursors)
        .values({
          source: `zoom:coach:${coach.id}`,
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
