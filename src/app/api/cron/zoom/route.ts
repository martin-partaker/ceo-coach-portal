import { NextResponse } from 'next/server';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { coaches, rawInputs, rawInputCeos, ingestionCursors, transcripts } from '@/db/schema';
import {
  listAllRecordingsForCoach,
  fetchParticipants,
  fetchTranscript,
  type ZoomRecording,
  type ZoomParticipant,
} from '@/lib/zoom/client';
import { classifyTranscript, type TranscriptClassification } from '@/lib/ingestion/classify';
import { fuzzyMatchCeoForCoach } from '@/lib/ingestion/match-ceo';
import { findCycleForOccurredAt } from '@/lib/ingestion/match-cycle';
import { isInternalEmail } from '@/lib/ingestion/identity';
import { INGESTION_CONFIG } from '@/lib/ingestion/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

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

const NON_INGESTED_TYPES: TranscriptClassification['meetingType'][] = [
  'internal_team',
  'coach_onboarding',
  'scheduling_only',
  'test_or_discard',
  'external',
];

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
          const outcome = await ingestMeeting({ coachId: coach.id, zoomEmail, meeting });
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

      // Cursor = now (we fetched up to now); overlap window covers gaps
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

type Outcome = 'matched' | 'pending_ceo' | 'discarded' | 'duplicate';

async function ingestMeeting(args: {
  coachId: string;
  zoomEmail: string;
  meeting: ZoomRecording;
}): Promise<Outcome> {
  const { coachId, zoomEmail, meeting } = args;

  // Skip if already ingested (cheap pre-check before fetching transcript)
  const [existing] = await db
    .select({ id: rawInputs.id })
    .from(rawInputs)
    .where(eq(rawInputs.externalId, meeting.uuid))
    .limit(1);
  if (existing) return 'duplicate';

  const occurredAt = new Date(meeting.start_time);

  // Auto-discard short meetings without an LLM call
  if (meeting.duration < INGESTION_CONFIG.minTranscriptMinutes) {
    await insertDiscarded({
      coachId,
      meeting,
      occurredAt,
      reason: 'too_short',
      participants: [],
      transcriptText: '',
    });
    return 'discarded';
  }

  // Fetch transcript first — no transcript = nothing to classify
  const transcriptResult = await fetchTranscript(meeting.id, zoomEmail);
  if (!transcriptResult) {
    await insertDiscarded({
      coachId,
      meeting,
      occurredAt,
      reason: 'no_transcript',
      participants: [],
      transcriptText: '',
    });
    return 'discarded';
  }

  let participants: ZoomParticipant[] = [];
  try {
    participants = await fetchParticipants(meeting.uuid);
  } catch (err) {
    console.warn(`Could not fetch participants for ${meeting.uuid}:`, err);
  }

  // Mark internal flag based on email domain when Zoom didn't set it
  participants = participants.map((p) => ({
    ...p,
    internal_user:
      p.internal_user === true ||
      (p.user_email ? isInternalEmail(p.user_email) : false),
  }));

  const classification = await classifyTranscript({
    topic: meeting.topic ?? '',
    participants,
    duration: meeting.duration,
    transcriptText: transcriptResult.transcript,
  });

  // Non-coaching meetings → discarded
  if (NON_INGESTED_TYPES.includes(classification.meetingType)) {
    await insertDiscarded({
      coachId,
      meeting,
      occurredAt,
      reason: classification.includeReason,
      participants,
      transcriptText: transcriptResult.transcript,
      classification,
    });
    return 'discarded';
  }

  const externals = participants.filter((p) => !p.internal_user && p.name?.trim());

  // Match each external participant against the coach's roster
  const matches = await Promise.all(
    externals.map(async (p) => ({
      participant: p,
      result: await fuzzyMatchCeoForCoach({ coachId, candidateName: p.name }),
    }))
  );

  const allMatched = matches.length > 0 && matches.every((m) => m.result.bestMatch !== null);
  const isGroup = classification.meetingType === 'coaching_group';

  let primaryCeoId: string | null = null;
  let matchStatus: Outcome = 'pending_ceo';
  let confidence: number | null = null;
  let candidates: unknown = null;

  if (allMatched && matches.length > 0) {
    matchStatus = 'matched';
    primaryCeoId = matches[0].result.bestMatch!.ceoId;
    confidence = Math.round(matches[0].result.bestMatch!.score * 100);
    if (matches.length > 1) {
      // Lowest confidence wins for the row-level confidence number
      confidence = Math.round(
        Math.min(...matches.map((m) => m.result.bestMatch!.score)) * 100
      );
    }
  } else {
    candidates = matches.map((m) => ({
      candidateName: m.participant.name,
      candidateEmail: m.participant.user_email ?? null,
      topMatches: m.result.topCandidates,
    }));
  }

  let cycleId: string | null = null;
  if (matchStatus === 'matched' && primaryCeoId) {
    const cycleMatch = await findCycleForOccurredAt({ ceoId: primaryCeoId, occurredAt });
    if (cycleMatch) {
      cycleId = cycleMatch.cycleId;
      if (!cycleMatch.confident) confidence = Math.min(confidence ?? 100, 75);
    }
  }

  const payloadJson = {
    meeting: {
      uuid: meeting.uuid,
      id: meeting.id,
      topic: meeting.topic,
      start_time: meeting.start_time,
      duration: meeting.duration,
    },
    participants,
    classification,
  };

  const [inserted] = await db
    .insert(rawInputs)
    .values({
      ceoId: primaryCeoId,
      cycleId,
      coachId,
      source: 'zoom',
      contentType: 'transcript',
      externalId: meeting.uuid,
      occurredAt,
      payloadJson,
      textContent: transcriptResult.transcript,
      matchStatus,
      matchConfidence: confidence,
      matchCandidates: candidates as object | null,
      classification: classification as unknown as object,
    })
    .returning({ id: rawInputs.id });

  // Group sessions: link all matched CEOs via raw_input_ceos
  if (isGroup && allMatched && inserted) {
    for (const m of matches) {
      const ceoId = m.result.bestMatch!.ceoId;
      await db
        .insert(rawInputCeos)
        .values({ rawInputId: inserted.id, ceoId })
        .onConflictDoNothing();
    }
  }

  // Project transcript to typed table only if classifier says it's worth using
  if (
    matchStatus === 'matched' &&
    cycleId &&
    classification.includeInMonthlySummary &&
    inserted
  ) {
    await db.insert(transcripts).values({
      cycleId,
      title: meeting.topic ?? 'Untitled meeting',
      content: transcriptResult.transcript,
      zoomMeetingId: String(meeting.id),
      duration: meeting.duration,
      recordedAt: occurredAt,
      sourceRawInputId: inserted.id,
    });
  }

  return matchStatus;
}

async function insertDiscarded(args: {
  coachId: string;
  meeting: ZoomRecording;
  occurredAt: Date;
  reason: string;
  participants: ZoomParticipant[];
  transcriptText: string;
  classification?: TranscriptClassification;
}) {
  await db.insert(rawInputs).values({
    coachId: args.coachId,
    source: 'zoom',
    contentType: 'transcript',
    externalId: args.meeting.uuid,
    occurredAt: args.occurredAt,
    payloadJson: {
      meeting: {
        uuid: args.meeting.uuid,
        id: args.meeting.id,
        topic: args.meeting.topic,
        start_time: args.meeting.start_time,
        duration: args.meeting.duration,
      },
      participants: args.participants,
      classification: args.classification ?? null,
      discardReason: args.reason,
    },
    textContent: args.transcriptText || null,
    matchStatus: 'discarded',
    classification: (args.classification ?? null) as unknown as object | null,
  });
}
