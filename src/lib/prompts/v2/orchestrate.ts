import 'server-only';
import { db } from '@/db';
import {
  ceos,
  cycles,
  cycleFacts as cycleFactsTable,
  cycleKpiValues,
  journalEntries,
  reportGenerationJobs,
  transcripts,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  CycleFactsSchema,
  PatternsSchema,
  type DraftedReport,
  type CycleFacts,
  type Patterns,
} from './schemas';

/**
 * v2 generation helpers. The orchestration logic lives in
 * `src/workflows/generate-report.ts` (Vercel Workflow). This file is
 * what's left over: pure helpers used both by the workflow and the
 * tRPC router.
 */

/** Create a new job row in the `pending` state and return its id. The
 *  caller hands the id to `start(generateReportWorkflow, ...)` so the
 *  workflow can mutate the same row at every stage transition. */
export async function createGenerationJob(cycleId: string): Promise<string> {
  const [row] = await db
    .insert(reportGenerationJobs)
    .values({ cycleId, status: 'pending' })
    .returning({ id: reportGenerationJobs.id });
  return row.id;
}

/** Build a copy-pasteable email body from the drafted report's email
 *  view. */
export function composeEmailRawText(d: DraftedReport): string {
  const parts: string[] = [];
  if (d.opening) parts.push(d.opening);
  if (d.wins_and_progress) parts.push(d.wins_and_progress);
  if (d.honest_feedback) parts.push(d.honest_feedback);
  if (d.key_insight) parts.push(d.key_insight);
  if (d.commitments) parts.push(d.commitments);
  if (d.going_deeper && d.going_deeper.trim()) {
    parts.push(`**Going deeper this month**\n\n${d.going_deeper.trim()}`);
  }
  if (d.closing) parts.push(d.closing);
  return parts.join('\n\n');
}

export async function loadCycleFactsRow(cycleId: string) {
  const [row] = await db
    .select()
    .from(cycleFactsTable)
    .where(eq(cycleFactsTable.cycleId, cycleId))
    .limit(1);
  return row ?? null;
}

/**
 * Load cached facts + patterns for a cycle and validate them against
 * their schemas. Returns null on any failure path — schema drift, missing
 * patterns, missing row, or stale-against-inputs — so the workflow falls
 * back to a clean Stage A + B run instead of feeding malformed or
 * outdated data into Stage C.
 *
 * Staleness check: if any input that feeds `fetchCycleContext` has been
 * touched since the facts were generated, we re-extract automatically.
 * The operator never has to choose "fast vs re-extract" — adding a new
 * journal, transcript, KPI, or editing the cycle/CEO triggers a fresh
 * Stage A on the next regenerate.
 *
 * Schema validation matters because the schema can evolve between
 * deploys; an old cached row from before a schema change should be
 * re-extracted, not pushed through with mismatched types that explode
 * in Stage C.
 */
export async function tryLoadCachedFacts(
  cycleId: string,
): Promise<{ facts: CycleFacts; patterns: Patterns; factsRowId: string } | null> {
  const row = await loadCycleFactsRow(cycleId);
  if (!row) return null;
  if (!row.patternsJson) return null; // partial cache (Stage B never finished) — re-run

  const latestInput = await latestInputTimestamp(cycleId);
  if (latestInput && latestInput > row.generatedAt) {
    console.log(
      `[orchestrate] cycle_facts stale for cycleId=${cycleId} ` +
        `(latest input ${latestInput.toISOString()} > generated ${row.generatedAt.toISOString()}); re-extracting.`,
    );
    return null;
  }

  const factsParsed = CycleFactsSchema.safeParse(row.factsJson);
  if (!factsParsed.success) {
    console.warn(
      `[orchestrate] cached cycle_facts.factsJson failed schema validation for cycleId=${cycleId}; re-extracting.`,
    );
    return null;
  }
  const patternsParsed = PatternsSchema.safeParse(row.patternsJson);
  if (!patternsParsed.success) {
    console.warn(
      `[orchestrate] cached cycle_facts.patternsJson failed schema validation for cycleId=${cycleId}; re-extracting.`,
    );
    return null;
  }
  return { facts: factsParsed.data, patterns: patternsParsed.data, factsRowId: row.id };
}

/**
 * The most recent timestamp across every input that feeds the v2
 * extractor for this cycle. Compared against `cycle_facts.generatedAt`
 * to decide if the cache is still fresh.
 *
 * Sources covered (mirrors what `fetchCycleContext` reads):
 *   - the cycle row itself (monthlyGoals / monthlyReflection /
 *     additionalContext edits) via `cycles.updatedAt`
 *   - the CEO's 10x goal via `ceos.tenXGoalUpdatedAt`
 *   - journal entries belonging to ANY of this CEO's cycles (because
 *     fetchCycleContext pulls journals across siblings via derived
 *     date-membership)
 *   - transcripts attached to this cycle
 *   - KPI values attached to this cycle
 *
 * Returns null if there are no inputs at all (fresh cycle); in that
 * case the cache (if any) cannot possibly be stale relative to inputs.
 */
async function latestInputTimestamp(cycleId: string): Promise<Date | null> {
  const [row] = await db
    .select({
      latest: sql<Date | null>`GREATEST(
        ${cycles.updatedAt},
        ${ceos.tenXGoalUpdatedAt},
        (SELECT MAX(${journalEntries.createdAt})
           FROM ${journalEntries}
           INNER JOIN ${cycles} AS jc ON ${journalEntries.cycleId} = jc.id
           WHERE jc.ceo_id = ${cycles.ceoId}),
        (SELECT MAX(${transcripts.createdAt})
           FROM ${transcripts}
           WHERE ${transcripts.cycleId} = ${cycles.id}),
        (SELECT MAX(${cycleKpiValues.createdAt})
           FROM ${cycleKpiValues}
           WHERE ${cycleKpiValues.cycleId} = ${cycles.id})
      )`,
    })
    .from(cycles)
    .leftJoin(ceos, eq(cycles.ceoId, ceos.id))
    .where(eq(cycles.id, cycleId))
    .limit(1);
  return row?.latest ?? null;
}
