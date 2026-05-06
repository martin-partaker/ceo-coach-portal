/**
 * Re-extract `ceos.tenXGoal` from the latest goal_worksheet raw_input
 * for every CEO that has one.
 *
 * Why: the original goal-worksheet projector stored the entire rendered
 * Q&A textContent into `tenXGoal`, so the coach UI shows
 * "Q: 1a. ... A: ..." rather than a clean goal sentence. The projector
 * has been updated to run an LLM extraction; this script re-runs it
 * for existing rows.
 *
 * Behaviour matches the live projector:
 *   - Skips a CEO whose `tenXGoalUpdatedAt` is newer than the latest
 *     worksheet submission (coach-set values win).
 *   - Skips a CEO whose latest worksheet extraction returns null.
 *
 * Run: pnpm backfill:ten-x-goals [--dry-run] [--only-raw]
 *   --dry-run   show planned changes without writing
 *   --only-raw  only re-extract for CEOs whose current tenXGoal looks
 *               like raw Q&A (contains both "Q: " and "A: ")
 */
import 'dotenv/config';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../src/db';
import { ceos, rawInputs } from '../src/db/schema';
import { extractTenXGoalFromWorksheet } from '../src/lib/ai/extract-ten-x-goal';

function looksLikeRawQA(s: string | null | undefined): boolean {
  if (!s) return false;
  return /\bQ:\s/.test(s) && /\bA:\s/.test(s);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyRaw = process.argv.includes('--only-raw');

  console.log(
    `Backfilling 10x goals${dryRun ? ' (dry run)' : ''}${onlyRaw ? ' [only raw Q&A]' : ''}`,
  );

  const allCeos = await db.select().from(ceos);
  console.log(`  found ${allCeos.length} CEOs`);

  const stats = {
    total: allCeos.length,
    skippedNoWorksheet: 0,
    skippedNewerCoachValue: 0,
    skippedNotRaw: 0,
    skippedExtractionEmpty: 0,
    updated: 0,
    unchanged: 0,
  };

  for (const ceo of allCeos) {
    if (onlyRaw && !looksLikeRawQA(ceo.tenXGoal)) {
      stats.skippedNotRaw++;
      continue;
    }

    const [latest] = await db
      .select()
      .from(rawInputs)
      .where(
        and(
          eq(rawInputs.ceoId, ceo.id),
          eq(rawInputs.contentType, 'goal_worksheet'),
        ),
      )
      .orderBy(desc(rawInputs.occurredAt))
      .limit(1);

    if (!latest) {
      stats.skippedNoWorksheet++;
      continue;
    }

    if (
      ceo.tenXGoal &&
      ceo.tenXGoalUpdatedAt &&
      ceo.tenXGoalUpdatedAt > latest.occurredAt &&
      !looksLikeRawQA(ceo.tenXGoal)
    ) {
      // Newer non-raw coach value → leave alone.
      stats.skippedNewerCoachValue++;
      continue;
    }

    const extracted = await extractTenXGoalFromWorksheet({
      ceoName: ceo.name,
      rawText: latest.textContent ?? '',
    });

    if (!extracted) {
      stats.skippedExtractionEmpty++;
      console.log(`  · ${ceo.name}: extraction returned null — leaving as-is`);
      continue;
    }

    if (extracted === ceo.tenXGoal) {
      stats.unchanged++;
      continue;
    }

    console.log(`  · ${ceo.name}:`);
    console.log(`      before: ${(ceo.tenXGoal ?? '(null)').slice(0, 100).replace(/\n/g, ' ')}`);
    console.log(`      after:  ${extracted}`);

    if (!dryRun) {
      await db
        .update(ceos)
        .set({ tenXGoal: extracted, tenXGoalUpdatedAt: latest.occurredAt })
        .where(eq(ceos.id, ceo.id));
    }
    stats.updated++;
  }

  console.log('\nDone.');
  console.log(JSON.stringify(stats, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
