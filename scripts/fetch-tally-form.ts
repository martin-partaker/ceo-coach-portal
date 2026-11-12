/**
 * Download every submission of one Tally form into a local JSON file.
 *
 *   ( set -a; . ./.env.staging; set +a; pnpm tsx scripts/fetch-tally-form.ts --form RGbPlP )
 *
 * For forms the portal knows about but has never ingested — in particular
 * "Feedback on your coaching sessions" (RGbPlP), where CEOs rate their own
 * sessions. Those answers are the closest thing we have to test cases for the
 * session audit: a reading, from the person in the room, of what the audit
 * tries to judge from a transcript.
 *
 * Reads Tally (GET only — the client has no other verb) and writes one file.
 * It touches no database. Whether these submissions should ever be ingested
 * into the portal, and who may see clients' judgements of their coaches
 * there, is a separate decision this script does not take.
 *
 * The file holds names, emails and those judgements. It is written outside
 * the repository by default so it cannot be committed.
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFormQuestions, listSubmissionsSince } from '../src/lib/tally/client';
import { assertRealSecret } from './staging-guard';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const formId = arg('--form');
  if (!formId) throw new Error('usage: fetch-tally-form.ts --form FORM_ID [--out FILE]');
  assertRealSecret('TALLY_API_KEY');

  const out =
    arg('--out') ??
    path.join(os.homedir(), 'Desktop', 'zoom-transcripts', `tally-${formId}.json`);
  const repo = path.resolve(__dirname, '..');
  if (path.resolve(out).startsWith(repo + path.sep)) {
    throw new Error('Refusing to write submissions inside the repository. Pick a path outside it.');
  }

  const questions = await getFormQuestions(formId);
  const { submissions } = await listSubmissionsSince(formId, null);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify({ formId, fetchedAt: new Date().toISOString(), questions, submissions }, null, 1),
  );

  const completed = submissions.filter(
    (s) => (s as { isCompleted?: boolean }).isCompleted !== false,
  ).length;
  console.log(`${submissions.length} submissions (${completed} completed), ${questions.length} questions`);
  console.log(`written to ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
