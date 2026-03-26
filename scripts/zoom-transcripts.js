const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv(envPath) {
  try {
    // Prefer dotenv if installed (handles edge cases well)
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    require("dotenv").config({ path: envPath });
    return;
  } catch (err) {
    if (err && err.code !== "MODULE_NOT_FOUND") throw err;
  }

  // Lightweight fallback: KEY=VALUE (supports quoted values)
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(__dirname, "..", ".env"));

const ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

// --- Step 1: Get Access Token ---
async function getAccessToken() {
  requireEnv("ZOOM_ACCOUNT_ID", ACCOUNT_ID);
  requireEnv("ZOOM_CLIENT_ID", CLIENT_ID);
  requireEnv("ZOOM_CLIENT_SECRET", CLIENT_SECRET);

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ACCOUNT_ID}`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}` },
    }
  );

  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// --- Step 2: Fetch All Cloud Recordings (paginated) ---
async function getAllRecordings(token) {
  const recordings = [];
  let nextPageToken = "";
  const from = "2023-01-01"; // adjust your date range
  const to = new Date().toISOString().split("T")[0];

  do {
    const params = new URLSearchParams({
      from,
      to,
      page_size: "300",
      ...(nextPageToken && { next_page_token: nextPageToken }),
    });

    // Account-level recordings list (works for account-wide access)
    const res = await fetch(`https://api.zoom.us/v2/accounts/me/recordings?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await res.json();
    if (data.meetings) recordings.push(...data.meetings);
    nextPageToken = data.next_page_token || "";
  } while (nextPageToken);

  return recordings;
}

async function getMeetingRecordings(token, meetingId) {
  const res = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}/recordings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Get meeting recordings failed: ${res.status} — ${JSON.stringify(data)}`);
  }
  return data;
}

function encodeMeetingUuid(uuid) {
  // Zoom requires double-encoding if uuid begins with "/" or contains "//"
  const once = encodeURIComponent(uuid);
  if (uuid.startsWith("/") || uuid.includes("//")) return encodeURIComponent(once);
  return once;
}

async function getPastMeetingParticipants(token, meetingUuid) {
  const participants = [];
  let nextPageToken = "";

  do {
    const params = new URLSearchParams({
      page_size: "300",
      ...(nextPageToken && { next_page_token: nextPageToken }),
    });

    const res = await fetch(
      `https://api.zoom.us/v2/past_meetings/${encodeMeetingUuid(meetingUuid)}/participants?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Get participants failed: ${res.status} — ${JSON.stringify(data)}`);
    }

    if (Array.isArray(data.participants)) participants.push(...data.participants);
    nextPageToken = data.next_page_token || "";
  } while (nextPageToken);

  return participants;
}

// --- Step 3: Download a single transcript file ---
async function downloadTranscript(token, downloadUrl, outputPath) {
  const url = new URL(downloadUrl);
  if (!url.searchParams.has("download")) url.searchParams.set("download", "1");

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = body ? ` — ${body.slice(0, 300)}` : "";
    throw new Error(`Download failed: ${res.status}${snippet}`);
  }

  const text = await res.text();
  fs.writeFileSync(outputPath, text, "utf8");
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// --- Main ---
async function main() {
  const token = await getAccessToken();
  console.log("✓ Authenticated");

  const meetings = await getAllRecordings(token);
  console.log(`✓ Found ${meetings.length} meetings with recordings`);

  const transcriptsDir = path.resolve(__dirname, "..", "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  let transcriptCount = 0;

  for (const meeting of meetings) {
    // Fetch per-meeting recording details to get transcript download URLs
    let meetingDetails;
    try {
      meetingDetails = await getMeetingRecordings(token, meeting.id);
    } catch (err) {
      console.warn(`  ✗ Failed to fetch meeting details: ${meeting.id} — ${err.message}`);
      continue;
    }

    const transcriptFiles = meetingDetails.recording_files?.filter((f) => {
      const isTranscript =
        f.recording_type === "audio_transcript" ||
        f.recording_type === "transcript" ||
        f.file_type === "TRANSCRIPT";
      const isReady = !f.status || f.status === "completed";
      return isTranscript && isReady && f.download_url;
    });

    if (!transcriptFiles?.length) continue;

    const safeTitle = meeting.topic.replace(/[^a-z0-9]/gi, "_").slice(0, 50);
    const date = meeting.start_time.split("T")[0];

    // Optional enrichment: participant list for "who was in it"
    let participants = null;
    let participantsError = null;
    if (meetingDetails.uuid) {
      try {
        participants = await getPastMeetingParticipants(token, meetingDetails.uuid);
      } catch (err) {
        participantsError = err.message;
      }
    } else {
      participantsError = "Missing meeting uuid; cannot query participants.";
    }

    for (const file of transcriptFiles) {
      const filename = `${date}_${safeTitle}_${meeting.id}.vtt`;
      const outputPath = path.join(transcriptsDir, filename);
      const metadataPath = `${outputPath}.json`;

      try {
        await downloadTranscript(token, file.download_url, outputPath);
        writeJson(metadataPath, {
          generated_at: new Date().toISOString(),
          meeting: {
            id: meeting.id,
            uuid: meetingDetails.uuid || null,
            topic: meetingDetails.topic || meeting.topic || null,
            start_time: meetingDetails.start_time || meeting.start_time || null,
            duration: meetingDetails.duration ?? meeting.duration ?? null,
            host_id: meetingDetails.host_id || null,
            account_id: meetingDetails.account_id || null,
          },
          transcript_file: {
            id: file.id || null,
            file_type: file.file_type || null,
            recording_type: file.recording_type || null,
            status: file.status || null,
            file_extension: file.file_extension || null,
            recording_start: file.recording_start || null,
            recording_end: file.recording_end || null,
            file_size: file.file_size || null,
          },
          participants: participants,
          participants_error: participantsError,
        });
        console.log(`  ↓ ${filename}`);
        transcriptCount++;
      } catch (err) {
        console.warn(`  ✗ Failed: ${filename} — ${err.message}`);
      }
    }
  }

  console.log(`\n✅ Done — downloaded ${transcriptCount} transcripts`);
}

main().catch(console.error);