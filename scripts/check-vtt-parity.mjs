/**
 * Holds `parseVtt` against the two things it must agree with, on real files.
 *
 *   node --experimental-strip-types scripts/check-vtt-parity.mjs [ARCHIVE_DIR]
 *
 * 1. `content` must equal, byte for byte, what the old `cleanVttTranscript`
 *    produced. That function is frozen below as it was on 2026-11-12, before
 *    it was replaced — it is the reference, do not "fix" it.
 * 2. `cueTimes` must equal what `scripts/backfill-vtt-cues.ts` computed for
 *    the same file, since 146 stored transcripts carry those values.
 *
 * Plain .mjs so it runs with a bare node and needs nothing installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVtt } from '../src/lib/zoom/vtt.ts';

function oldCleanVttTranscript(vtt) {
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

function backfillCues(raw) {
  const cues = [];
  let pending = null;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (m) { pending = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]); continue; }
    if (line.startsWith('WEBVTT') || line.startsWith('NOTE')) continue;
    if (/^\d+$/.test(s)) continue;
    if (s === '') continue;
    cues.push(pending ?? 0);
  }
  return cues.join(',');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vtt')) out.push(p);
  }
  return out;
}

const root = process.argv[2] ?? path.join(os.homedir(), 'Desktop', 'zoom-transcripts', 'transcripts');
const files = walk(root).sort();
let contentSame = 0, cuesSame = 0, aligned = 0;
const bad = [];
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const got = parseVtt(raw);
  const okContent = got.content === oldCleanVttTranscript(raw);
  const okCues = got.cueTimes === backfillCues(raw);
  const okAligned =
    got.cueTimes !== null &&
    got.cueTimes.split(',').length === got.content.split('\n').length;
  if (okContent) contentSame++;
  if (okCues) cuesSame++;
  if (okAligned) aligned++;
  if (!(okContent && okCues && okAligned) && bad.length < 5) {
    bad.push(`${path.basename(f)} content=${okContent} cues=${okCues} aligned=${okAligned}`);
  }
}
console.log(`${files.length} VTT files under ${root}`);
console.log(`  content identical to the old cleaner : ${contentSame}`);
console.log(`  cue times identical to the backfill  : ${cuesSame}`);
console.log(`  one cue per content line             : ${aligned}`);
for (const b of bad) console.log('  MISMATCH', b);
if (contentSame !== files.length || cuesSame !== files.length || aligned !== files.length) {
  process.exit(1);
}
