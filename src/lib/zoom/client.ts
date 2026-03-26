import 'server-only';

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID!;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID!;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET!;

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');

  const res = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'account_credentials',
      account_id: ZOOM_ACCOUNT_ID,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoom OAuth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}

async function zoomFetch(path: string, params?: Record<string, string>): Promise<Response> {
  const token = await getAccessToken();
  const url = new URL(`https://api.zoom.us/v2${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  return res;
}

export interface ZoomRecording {
  uuid: string;
  id: number;
  topic: string;
  start_time: string;
  duration: number;
  recording_files: ZoomRecordingFile[];
}

interface ZoomRecordingFile {
  id: string;
  file_type: string;
  download_url: string;
  recording_type: string;
  status: string;
}

interface ListRecordingsResponse {
  from: string;
  to: string;
  meetings: ZoomRecording[];
}

export async function listRecordings(userEmail: string, fromDate?: string, toDate?: string): Promise<ZoomRecording[]> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const res = await zoomFetch(`/users/${encodeURIComponent(userEmail)}/recordings`, {
    from: fromDate ?? thirtyDaysAgo.toISOString().split('T')[0],
    to: toDate ?? now.toISOString().split('T')[0],
    page_size: '50',
  });

  if (!res.ok) {
    if (res.status === 404) return [];
    const text = await res.text();
    throw new Error(`Zoom recordings list failed (${res.status}): ${text}`);
  }

  const data: ListRecordingsResponse = await res.json();
  return data.meetings ?? [];
}

export async function fetchTranscript(meetingId: string | number, userEmail: string): Promise<{ transcript: string; meetingTopic: string } | null> {
  const res = await zoomFetch(`/meetings/${meetingId}/recordings`);

  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    throw new Error(`Zoom meeting recordings failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Find transcript file (TRANSCRIPT or TIMELINE type, VTT format)
  const transcriptFile = data.recording_files?.find(
    (f: ZoomRecordingFile) =>
      f.file_type === 'TRANSCRIPT' ||
      f.recording_type === 'audio_transcript'
  );

  if (!transcriptFile) return null;

  // Download the transcript
  const token = await getAccessToken();
  const downloadRes = await fetch(`${transcriptFile.download_url}?access_token=${token}`);

  if (!downloadRes.ok) {
    throw new Error(`Transcript download failed (${downloadRes.status})`);
  }

  const rawTranscript = await downloadRes.text();

  // Clean VTT format to plain text
  const transcript = cleanVttTranscript(rawTranscript);

  return {
    transcript,
    meetingTopic: data.topic ?? 'Untitled meeting',
  };
}

function cleanVttTranscript(vtt: string): string {
  return vtt
    .split('\n')
    .filter((line) => {
      // Remove VTT headers, timestamps, and blank lines
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
