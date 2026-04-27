/**
 * Tally backfill — replays cached tally-data/forms/*\/submissions.json
 * through the same matcher used by the cron, then optionally fetches
 * live-API submissions for the last 12 months. Idempotent.
 *
 * Run: pnpm backfill:tally [--live]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { eq, desc } from 'drizzle-orm';
import { db } from '../src/db';
import { tallyForms } from '../src/db/schema';
import { upsertTallyForm } from '../src/lib/tally/registry';
import { listForms, getFormQuestions, listSubmissionsSince } from '../src/lib/tally/client';
import { inferIdentityFields } from '../src/lib/tally/heuristics';
import { ingestTallySubmission } from '../src/lib/ingestion/ingest-tally';
import type { TallyForm, TallyQuestion, TallySubmission } from '../src/lib/tally/client';

interface SubmissionsFile {
  questions: TallyQuestion[];
  submissions: TallySubmission[];
}

const TALLY_DATA_DIR = path.resolve(__dirname, '..', 'tally-data', 'forms');

async function syncRegistryFromLive() {
  const live = await listForms();
  for (const form of live) {
    const questions = await getFormQuestions(form.id);
    await upsertTallyForm({ form, questionsSnapshot: questions });
    console.log(`  ↳ registered ${form.name} (${form.id})`);
  }
  return live;
}

function readLocalForm(formId: string): { form: TallyForm; data: SubmissionsFile } | null {
  if (!fs.existsSync(TALLY_DATA_DIR)) return null;
  const dirs = fs.readdirSync(TALLY_DATA_DIR);
  const dir = dirs.find((d) => d.endsWith(`_${formId}`));
  if (!dir) return null;
  const formPath = path.join(TALLY_DATA_DIR, dir, 'form.json');
  const subsPath = path.join(TALLY_DATA_DIR, dir, 'submissions.json');
  if (!fs.existsSync(formPath) || !fs.existsSync(subsPath)) return null;
  const form = JSON.parse(fs.readFileSync(formPath, 'utf8'));
  const data = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
  return { form, data };
}

async function replayLocal(formRow: typeof tallyForms.$inferSelect) {
  const local = readLocalForm(formRow.formId);
  if (!local) {
    console.log(`  (no local cache)`);
    return { ingested: 0, matched: 0, pendingCeo: 0, pendingCycle: 0, discarded: 0, duplicates: 0, errors: 0 };
  }

  const { questions, submissions } = local.data;
  const heuristic = inferIdentityFields(questions);
  const emailQid = formRow.emailQuestionId ?? heuristic.emailQuestionId;
  const nameQid = formRow.nameQuestionId ?? heuristic.nameQuestionId;

  const ordered = [...submissions].reverse();
  const counts = { ingested: 0, matched: 0, pendingCeo: 0, pendingCycle: 0, discarded: 0, duplicates: 0, errors: 0 };

  for (const sub of ordered) {
    try {
      const outcome = await ingestTallySubmission({
        formRow,
        submission: sub,
        questions,
        emailQid,
        nameQid,
      });
      counts.ingested++;
      if (outcome === 'duplicate') counts.duplicates++;
      else if (outcome === 'matched') counts.matched++;
      else if (outcome === 'pending_ceo') counts.pendingCeo++;
      else if (outcome === 'pending_cycle') counts.pendingCycle++;
      else if (outcome === 'discarded') counts.discarded++;
    } catch (err) {
      counts.errors++;
      const cause = err instanceof Error && 'cause' in err ? (err as { cause?: unknown }).cause : null;
      console.error(
        `    ✗ ${sub.id}:`,
        err instanceof Error ? err.message.split('\n')[0] : err,
        cause ? `(cause: ${cause instanceof Error ? cause.message : JSON.stringify(cause)})` : ''
      );
    }
  }
  return counts;
}

async function replayLive(formRow: typeof tallyForms.$inferSelect) {
  const questions = await getFormQuestions(formRow.formId);
  const heuristic = inferIdentityFields(questions);
  const emailQid = formRow.emailQuestionId ?? heuristic.emailQuestionId;
  const nameQid = formRow.nameQuestionId ?? heuristic.nameQuestionId;

  // Pull everything (no cursor) — duplicates are skipped via unique index.
  const { submissions } = await listSubmissionsSince(formRow.formId, null);
  const ordered = [...submissions].reverse();
  const counts = { ingested: 0, matched: 0, pendingCeo: 0, pendingCycle: 0, discarded: 0, duplicates: 0, errors: 0 };

  for (const sub of ordered) {
    try {
      const outcome = await ingestTallySubmission({
        formRow,
        submission: sub,
        questions,
        emailQid,
        nameQid,
      });
      counts.ingested++;
      if (outcome === 'duplicate') counts.duplicates++;
      else if (outcome === 'matched') counts.matched++;
      else if (outcome === 'pending_ceo') counts.pendingCeo++;
      else if (outcome === 'pending_cycle') counts.pendingCycle++;
      else if (outcome === 'discarded') counts.discarded++;
    } catch (err) {
      counts.errors++;
      const cause = err instanceof Error && 'cause' in err ? (err as { cause?: unknown }).cause : null;
      console.error(
        `    ✗ ${sub.id}:`,
        err instanceof Error ? err.message.split('\n')[0] : err,
        cause ? `(cause: ${cause instanceof Error ? cause.message : JSON.stringify(cause)})` : ''
      );
    }
  }
  return counts;
}

async function main() {
  const useLive = process.argv.includes('--live');

  console.log('→ Tally backfill starting');
  console.log('  registry sync (live)');
  await syncRegistryFromLive();

  // Anything 'pending_review' shouldn't be ingested. Operator must register first.
  const active = await db
    .select()
    .from(tallyForms)
    .where(eq(tallyForms.status, 'active'))
    .orderBy(desc(tallyForms.updatedAt));

  if (active.length === 0) {
    console.log('  ⚠ no active forms — register them in /admin/inbox first');
    return;
  }

  for (const formRow of active) {
    console.log(`\n  ↳ ${formRow.name} (${formRow.formId}) [${formRow.contentType}]`);

    const localCounts = await replayLocal(formRow);
    console.log(`    local:  ${JSON.stringify(localCounts)}`);

    if (useLive) {
      const liveCounts = await replayLive(formRow);
      console.log(`    live :  ${JSON.stringify(liveCounts)}`);
    }
  }

  console.log('\n✅ Tally backfill complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
