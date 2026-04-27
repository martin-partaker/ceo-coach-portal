import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { rawInputs } from '@/db/schema';
import {
  fetchParticipants,
  fetchTranscript,
  type ZoomRecording,
  type ZoomParticipant,
} from '@/lib/zoom/client';
import { classifyTranscript, type TranscriptClassification } from './classify';
import { fuzzyMatchCeoForCoach } from './match-ceo';
import { isInternalEmail } from './identity';
import { INGESTION_CONFIG } from './config';

export type ZoomIngestOutcome = 'matched' | 'pending_ceo' | 'discarded' | 'duplicate';

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

  // Short meetings: skip the LLM call (cost guard) but still ingest as
  // pending_ceo so the super admin sees them. Most will get archived in
  // one click but occasionally a short check-in carries real signal.
  if (meeting.duration < INGESTION_CONFIG.minTranscriptMinutes) {
    await insertPendingShort({ coachId, meeting, occurredAt });
    return 'pending_ceo';
  }

  let transcriptText: string | null = args.prefetched?.transcriptText ?? null;
  if (transcriptText == null) {
    const fetched = await fetchTranscript(meeting.id, zoomEmail);
    transcriptText = fetched?.transcript ?? null;
  }
  if (!transcriptText) {
    await insertPendingNoTranscript({ coachId, meeting, occurredAt });
    return 'pending_ceo';
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

  // Don't auto-discard based on classifier verdict. The super admin will
  // make the final call from triage — even an "internal_team" classification
  // could be wrong (e.g. when a participant name happens to match an existing
  // CEO). The classifier's verdict is preserved on raw_inputs.classification
  // so the triage card can surface it as a hint.

  const externals = participants.filter((p) => !p.internal_user && p.name?.trim());

  const matches = await Promise.all(
    externals.map(async (p) => ({
      participant: p,
      result: await fuzzyMatchCeoForCoach({ coachId, candidateName: p.name }),
    }))
  );

  // Zoom transcripts ALWAYS require human verification — names from Zoom
  // guests are inherently fuzzy (no email), and the cost of misattribution
  // (cross-CEO contamination in the monthly summary) is high. The fuzzy
  // matcher still runs to produce candidates for the triage suggester, but
  // we never auto-accept.
  const matchStatus: ZoomIngestOutcome = 'pending_ceo';
  const candidates: unknown = matches.map((m) => ({
    candidateName: m.participant.name,
    candidateEmail: m.participant.user_email ?? null,
    topMatches: m.result.topCandidates,
  }));
  const isGroup = classification.meetingType === 'coaching_group';
  const primaryCeoId: string | null = null;
  const confidence: number | null = null;
  const cycleId: string | null = null;

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

  // Group sessions: defer rawInputCeos linkage until the operator confirms
  // each CEO via triage. (Was auto-linked when matched; now always pending.)
  void isGroup;
  void inserted;

  return matchStatus;
}

async function insertPendingShort(args: {
  coachId: string;
  meeting: ZoomRecording;
  occurredAt: Date;
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
        participants: [],
        classification: null,
        ingestNote: 'too_short_for_classification',
      },
      textContent: null,
      matchStatus: 'pending_ceo',
      classification: {
        meetingType: 'scheduling_only',
        includeInMonthlySummary: false,
        includeReason: `Skipped LLM (duration ${args.meeting.duration} min < ${INGESTION_CONFIG.minTranscriptMinutes} min threshold).`,
      } as unknown as object,
    })
    .onConflictDoNothing({ target: [rawInputs.source, rawInputs.externalId] });
}

async function insertPendingNoTranscript(args: {
  coachId: string;
  meeting: ZoomRecording;
  occurredAt: Date;
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
        participants: [],
        classification: null,
        ingestNote: 'no_transcript_available',
      },
      textContent: null,
      matchStatus: 'pending_ceo',
      classification: {
        meetingType: 'test_or_discard',
        includeInMonthlySummary: false,
        includeReason: 'No transcript file available — meeting may not have been cloud-recorded with transcription enabled.',
      } as unknown as object,
    })
    .onConflictDoNothing({ target: [rawInputs.source, rawInputs.externalId] });
}
