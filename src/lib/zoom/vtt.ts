/**
 * Zoom VTT -> the text we store, plus the second each stored line starts at.
 *
 * `transcripts.content` is the VTT with its cue lines stripped. Until
 * 2026-11 that stripping threw the timings away, so nothing downstream could
 * jump from a quote to the moment in the recording. This returns both, from
 * one pass, so they cannot drift apart.
 *
 * `content` must stay byte-identical to what the old `cleanVttTranscript`
 * produced: 257 stored transcripts, their SHA256s, and every audit's line
 * indices depend on it. The filter below is that function's filter, in the
 * same order, and `scripts/check-vtt-parity.mjs` holds the two against each
 * other on real files.
 *
 * `cueTimes` is comma-separated start seconds, one per line of `content`
 * split on "\n" — the same shape `scripts/backfill-vtt-cues.ts` wrote for
 * the transcripts captured before this existed. It is null when the file
 * carries no cue lines at all, rather than a row of zeros that would look
 * like real timings.
 *
 * No imports, on purpose: it runs anywhere, including a bare `node` check.
 */

const STARTS_WITH_TIME = /^\d{2}:\d{2}:\d{2}/;
const CUE_START = /^(\d{2}):(\d{2}):(\d{2})/;

export interface ParsedVtt {
  content: string;
  cueTimes: string | null;
}

export function parseVtt(vtt: string): ParsedVtt {
  const kept: string[] = [];
  const secs: number[] = [];
  let pending: number | null = null;
  let sawCue = false;

  for (const line of vtt.split('\n')) {
    const t = line.trim();
    if (line.startsWith('WEBVTT')) continue;
    if (line.startsWith('NOTE')) continue;
    if (/^\d+$/.test(t)) continue;
    if (STARTS_WITH_TIME.test(t)) {
      // Dropped either way, as before. It only moves the clock when it is a
      // real cue line: a spoken line that happens to open with "10:30:00"
      // must not be read as a timing.
      if (t.includes('-->')) {
        const m = CUE_START.exec(t);
        if (m) {
          pending = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          sawCue = true;
        }
      }
      continue;
    }
    if (t === '') continue;
    kept.push(line);
    secs.push(pending ?? 0);
  }

  const content = kept.join('\n').trim();
  // Every kept line has non-blank text, so the trim above can shave the ends
  // of the first and last line but never removes a line: one cue per line
  // holds. With nothing kept there is nothing to time.
  const cueTimes = sawCue && kept.length > 0 ? secs.join(',') : null;
  return { content, cueTimes };
}
