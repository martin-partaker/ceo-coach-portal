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
import { listAllRecordingsForCoach, listAllUsers } from '../src/lib/zoom/client';
import { ingestZoomMeeting } from '../src/lib/ingestion/ingest-zoom';
import {
  ensureCoachByZoomEmail,
  isInternalEmail,
} from '../src/lib/ingestion/identity';
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

async function replayLocal(initialCoachList: CoachLite[]) {
  const pairs = listLocalTranscripts();
  console.log(`  found ${pairs.length} local transcript(s)`);
  const counts = {
    processed: 0,
    matched: 0,
    pendingCeo: 0,
    discarded: 0,
    duplicates: 0,
    autoCreatedCoaches: 0,
    skippedNoInternalHost: 0,
    errors: 0,
  };

  // Mutable list — we add coaches on-the-fly as we discover @partaker.com
  // hosts that aren't yet in the system.
  const coachList = [...initialCoachList];
  const coachByEmail = new Map(coachList.map((c) => [c.zoomEmail.toLowerCase(), c]));

  for (const { vttPath, jsonPath } of pairs) {
    try {
      const sidecar: SidecarFile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

      // Find an internal host. If they're not in coaches yet, create them
      // (the user assumed @partaker.com == coach, so don't drop transcripts).
      const internalHosts = (sidecar.participants ?? [])
        .filter((p) => p.internal_user || (p.user_email && isInternalEmail(p.user_email)))
        .filter((p) => !!p.user_email);

      if (internalHosts.length === 0) {
        counts.skippedNoInternalHost++;
        continue;
      }

      let coach: CoachLite | undefined;
      for (const host of internalHosts) {
        const email = host.user_email!.toLowerCase().trim();
        if (coachByEmail.has(email)) {
          coach = coachByEmail.get(email);
          break;
        }
        // Auto-create coach record
        const { coachId, created } = await ensureCoachByZoomEmail({
          email,
          name: host.name,
        });
        const newCoach: CoachLite = { id: coachId, zoomEmail: email, zoomHostId: null };
        coachList.push(newCoach);
        coachByEmail.set(email, newCoach);
        if (created) {
          counts.autoCreatedCoaches++;
          console.log(`    + auto-created coach for ${email} (${host.name})`);
        }
        coach = newCoach;
        break;
      }
      if (!coach) {
        counts.skippedNoInternalHost++;
        continue;
      }

      const vtt = fs.readFileSync(vttPath, 'utf8');
      const transcriptText = cleanVtt(vtt);

      // Local backfill quirk: transcripts/ sometimes have the same UUID
      // across different instances of a recurring meeting (the original
      // download script didn't track per-instance UUIDs cleanly). Synthesize
      // a unique external_id by combining UUID + start_time so each .vtt
      // file gets its own raw_input row.
      const syntheticUuid = `${sidecar.meeting.uuid}:${sidecar.meeting.start_time}`;
      const meeting: ZoomRecording = {
        uuid: syntheticUuid,
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

async function replayLive(coachList: CoachLite[], months: number = 12) {
  const counts = {
    processed: 0,
    matched: 0,
    pendingCeo: 0,
    discarded: 0,
    duplicates: 0,
    errors: 0,
  };
  const now = new Date();
  const fromDate = new Date(now.getTime() - months * 30 * 24 * 60 * 60 * 1000);

  for (const coach of coachList) {
    try {
      const meetings = await listAllRecordingsForCoach(coach.zoomEmail, fromDate, now);
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

async function discoverInternalCoachesFromZoom(): Promise<number> {
  let created = 0;
  try {
    const users = await listAllUsers();
    for (const u of users) {
      if (!u.email || !isInternalEmail(u.email)) continue;
      const fullName =
        [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || undefined;
      const { created: wasCreated } = await ensureCoachByZoomEmail({
        email: u.email,
        name: fullName,
      });
      if (wasCreated) {
        created++;
        console.log(`    + discovered coach ${u.email} (${fullName ?? '(no name)'})`);
      }
    }
  } catch (err) {
    console.error(
      '  ⚠ Zoom user discovery failed (continuing with local data):',
      err instanceof Error ? err.message : err
    );
  }
  return created;
}

async function main() {
  const useLive = process.argv.includes('--live');
  const monthsArg = process.argv.find((a) => a.startsWith('--months='));
  const months = monthsArg ? parseInt(monthsArg.split('=')[1], 10) : 12;
  console.log(`→ Zoom backfill starting (live=${useLive}, range=${months}mo)`);

  // Discover all @partaker.com users from Zoom up front so live replay
  // covers every coach — not just those who happened to host a transcript
  // we have locally cached.
  if (useLive) {
    console.log('\n  discovering internal coaches via Zoom /users');
    const newCount = await discoverInternalCoachesFromZoom();
    console.log(`  discovered: +${newCount} new coach record(s)`);
  }

  console.log('\n  local replay');
  const initialCoaches = await loadCoaches();
  const local = await replayLocal(initialCoaches);
  console.log(`  local result: ${JSON.stringify(local)}`);

  if (useLive) {
    // Reload from DB — local replay may have auto-created coaches we now
    // need to query Zoom for.
    const coachList = await loadCoaches();
    console.log(`\n  live replay (last ${months}mo) across ${coachList.length} coach(es)`);
    const live = await replayLive(coachList, months);
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
