/**
 * Zoom backfill — replays cached transcripts/*.vtt + .vtt.json through
 * the same matcher used by the cron, then optionally fetches live-API
 * recordings for the last 12 months. Idempotent.
 *
 * Run: pnpm backfill:zoom [--live]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../src/db';
import { coaches } from '../src/db/schema';
import { listAllRecordingsForCoach } from '../src/lib/zoom/client';
import { ingestZoomMeeting } from '../src/lib/ingestion/ingest-zoom';
import type { ZoomRecording, ZoomParticipant } from '../src/lib/zoom/client';

const TRANSCRIPTS_DIR = path.resolve(__dirname, '..', 'transcripts');

interface SidecarFile {
  meeting: {
    id: number;
    uuid: string;
    topic: string;
    start_time: string;
    duration: number;
    host_id: string;
    account_id: string;
  };
  participants: ZoomParticipant[];
  participants_error: unknown;
}

function cleanVtt(vtt: string): string {
  return vtt
    .split('\n')
    .filter((line) => {
      if (line.startsWith('WEBVTT')) return false;
      if (line.startsWith('NOTE')) return false;
      if (/^\d+$/.test(line.trim())) return false;
      if (/^\d{2}:\d{2}:\d{2}/.test(line.trim())) return false;
      if (line.trim() === '') return false;
      return true;
    })
    .join('\n')
    .trim();
}

function listLocalTranscripts(): Array<{ vttPath: string; jsonPath: string }> {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return [];
  const files = fs.readdirSync(TRANSCRIPTS_DIR);
  const pairs: Array<{ vttPath: string; jsonPath: string }> = [];
  for (const f of files) {
    if (!f.endsWith('.vtt')) continue;
    const jsonName = `${f}.json`;
    if (!files.includes(jsonName)) continue;
    pairs.push({
      vttPath: path.join(TRANSCRIPTS_DIR, f),
      jsonPath: path.join(TRANSCRIPTS_DIR, jsonName),
    });
  }
  return pairs;
}

interface CoachLite {
  id: string;
  zoomEmail: string;
  zoomHostId: string | null;
}

async function loadCoaches(): Promise<CoachLite[]> {
  const rows = await db
    .select({ id: coaches.id, zoomUserEmail: coaches.zoomUserEmail })
    .from(coaches)
    .where(isNotNull(coaches.zoomUserEmail));

  // We don't have host_id stored — match by Zoom email. Local sidecars
  // include host_id; map by email when participants[].user_email exists.
  return rows.map((r) => ({ id: r.id, zoomEmail: r.zoomUserEmail!, zoomHostId: null }));
}

function pickCoachForMeeting(
  coachList: CoachLite[],
  sidecar: SidecarFile
): CoachLite | null {
  const internalEmails = sidecar.participants
    .filter((p) => p.internal_user)
    .map((p) => (p.user_email ?? '').toLowerCase().trim())
    .filter(Boolean);
  if (internalEmails.length === 0) return null;

  for (const coach of coachList) {
    if (internalEmails.includes(coach.zoomEmail.toLowerCase().trim())) return coach;
  }
  return null;
}

async function replayLocal(coachList: CoachLite[]) {
  const pairs = listLocalTranscripts();
  console.log(`  found ${pairs.length} local transcript(s)`);
  const counts = {
    processed: 0,
    matched: 0,
    pendingCeo: 0,
    discarded: 0,
    duplicates: 0,
    skippedNoCoach: 0,
    errors: 0,
  };

  for (const { vttPath, jsonPath } of pairs) {
    try {
      const sidecar: SidecarFile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const coach = pickCoachForMeeting(coachList, sidecar);
      if (!coach) {
        counts.skippedNoCoach++;
        continue;
      }

      const vtt = fs.readFileSync(vttPath, 'utf8');
      const transcriptText = cleanVtt(vtt);

      const meeting: ZoomRecording = {
        uuid: sidecar.meeting.uuid,
        id: sidecar.meeting.id,
        topic: sidecar.meeting.topic,
        start_time: sidecar.meeting.start_time,
        duration: sidecar.meeting.duration,
        recording_files: [],
      };

      const outcome = await ingestZoomMeeting({
        coachId: coach.id,
        zoomEmail: coach.zoomEmail,
        meeting,
        prefetched: { participants: sidecar.participants, transcriptText },
      });
      counts.processed++;
      if (outcome === 'duplicate') counts.duplicates++;
      else if (outcome === 'matched') counts.matched++;
      else if (outcome === 'pending_ceo') counts.pendingCeo++;
      else if (outcome === 'discarded') counts.discarded++;
    } catch (err) {
      counts.errors++;
      console.error(`    ✗ ${path.basename(jsonPath)}:`, err instanceof Error ? err.message : err);
    }
  }
  return counts;
}

async function replayLive(coachList: CoachLite[]) {
  const counts = {
    processed: 0,
    matched: 0,
    pendingCeo: 0,
    discarded: 0,
    duplicates: 0,
    errors: 0,
  };
  const now = new Date();
  const twelveMonthsAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  for (const coach of coachList) {
    try {
      const meetings = await listAllRecordingsForCoach(coach.zoomEmail, twelveMonthsAgo, now);
      console.log(`  ↳ ${coach.zoomEmail}: ${meetings.length} meetings`);
      for (const meeting of meetings) {
        try {
          const outcome = await ingestZoomMeeting({
            coachId: coach.id,
            zoomEmail: coach.zoomEmail,
            meeting,
          });
          counts.processed++;
          if (outcome === 'duplicate') counts.duplicates++;
          else if (outcome === 'matched') counts.matched++;
          else if (outcome === 'pending_ceo') counts.pendingCeo++;
          else if (outcome === 'discarded') counts.discarded++;
        } catch (err) {
          counts.errors++;
          console.error(`    ✗ ${meeting.uuid}:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      counts.errors++;
      console.error(`  ✗ coach ${coach.zoomEmail}:`, err instanceof Error ? err.message : err);
    }
  }
  return counts;
}

async function main() {
  const useLive = process.argv.includes('--live');
  console.log('→ Zoom backfill starting');

  const coachList = await loadCoaches();
  if (coachList.length === 0) {
    console.log('  ⚠ no coaches with zoomUserEmail set');
    return;
  }

  console.log('\n  local replay');
  const local = await replayLocal(coachList);
  console.log(`  local result: ${JSON.stringify(local)}`);

  if (useLive) {
    console.log('\n  live replay (last 12 months)');
    const live = await replayLive(coachList);
    console.log(`  live result: ${JSON.stringify(live)}`);
  }

  console.log('\n✅ Zoom backfill complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Suppress unused export warning for eq import (drizzle helper kept for parity).
void eq;
