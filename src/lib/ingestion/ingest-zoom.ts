import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { rawInputs, rawInputCeos } from '@/db/schema';
import {
  fetchParticipants,
  fetchTranscript,
  type ZoomRecording,
  type ZoomParticipant,
} from '@/lib/zoom/client';
import { classifyTranscript, type TranscriptClassification } from './classify';
import { fuzzyMatchCeoForCoach } from './match-ceo';
import { findCycleForOccurredAt } from './match-cycle';
import { isInternalEmail } from './identity';
import { projectRawInput } from './project';
import { INGESTION_CONFIG } from './config';

export type ZoomIngestOutcome = 'matched' | 'pending_ceo' | 'discarded' | 'duplicate';

const NON_INGESTED_TYPES: TranscriptClassification['meetingType'][] = [
  'internal_team',
  'coach_onboarding',
  'scheduling_only',
  'test_or_discard',
  'external',
];

/**
 * Ingest a Zoom meeting. If `prefetched` is omitted, transcript +
 * participants are fetched from Zoom. Pass them in to skip API calls
 * (used by the local-file backfill).
 */
export async function ingestZoomMeeting(args: {
  coachId: string;
  zoomEmail: string;
  meeting: ZoomRecording;
  prefetched?: {
    participants: ZoomParticipant[];
    transcriptText: string | null;
  };
}): Promise<ZoomIngestOutcome> {
  const { coachId, zoomEmail, meeting } = args;

  const [existing] = await db
    .select({ id: rawInputs.id })
    .from(rawInputs)
    .where(eq(rawInputs.externalId, meeting.uuid))
    .limit(1);
  if (existing) return 'duplicate';

  const occurredAt = new Date(meeting.start_time);

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

  let transcriptText: string | null = args.prefetched?.transcriptText ?? null;
  if (transcriptText == null) {
    const fetched = await fetchTranscript(meeting.id, zoomEmail);
    transcriptText = fetched?.transcript ?? null;
  }
  if (!transcriptText) {
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

  let participants: ZoomParticipant[] = args.prefetched?.participants ?? [];
  if (participants.length === 0) {
    try {
      participants = await fetchParticipants(meeting.uuid);
    } catch (err) {
      console.warn(`Could not fetch participants for ${meeting.uuid}:`, err);
    }
  }

  participants = participants.map((p) => ({
    ...p,
    internal_user:
      p.internal_user === true || (p.user_email ? isInternalEmail(p.user_email) : false),
  }));

  const classification = await classifyTranscript({
    topic: meeting.topic ?? '',
    participants,
    duration: meeting.duration,
    transcriptText,
  });

  if (NON_INGESTED_TYPES.includes(classification.meetingType)) {
    await insertDiscarded({
      coachId,
      meeting,
      occurredAt,
      reason: classification.includeReason,
      participants,
      transcriptText,
      classification,
    });
    return 'discarded';
  }

  const externals = participants.filter((p) => !p.internal_user && p.name?.trim());

  const matches = await Promise.all(
    externals.map(async (p) => ({
      participant: p,
      result: await fuzzyMatchCeoForCoach({ coachId, candidateName: p.name }),
    }))
  );

  const allMatched = matches.length > 0 && matches.every((m) => m.result.bestMatch !== null);
  const isGroup = classification.meetingType === 'coaching_group';

  let primaryCeoId: string | null = null;
  let matchStatus: ZoomIngestOutcome = 'pending_ceo';
  let confidence: number | null = null;
  let candidates: unknown = null;

  if (allMatched && matches.length > 0) {
    matchStatus = 'matched';
    primaryCeoId = matches[0].result.bestMatch!.ceoId;
    confidence = Math.round(
      Math.min(...matches.map((m) => m.result.bestMatch!.score)) * 100
    );
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
      textContent: transcriptText,
      matchStatus,
      matchConfidence: confidence,
      matchCandidates: candidates as object | null,
      classification: classification as unknown as object,
    })
    .onConflictDoNothing({ target: [rawInputs.source, rawInputs.externalId] })
    .returning({ id: rawInputs.id });

  if (!inserted) return 'duplicate';

  if (isGroup && allMatched && inserted) {
    for (const m of matches) {
      const ceoId = m.result.bestMatch!.ceoId;
      await db
        .insert(rawInputCeos)
        .values({ rawInputId: inserted.id, ceoId })
        .onConflictDoNothing();
    }
  }

  if (matchStatus === 'matched' && cycleId && inserted) {
    await projectRawInput(inserted.id);
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
  await db
    .insert(rawInputs)
    .values({
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
  })
  .onConflictDoNothing({ target: [rawInputs.source, rawInputs.externalId] });
}
