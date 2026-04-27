import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { isNotNull, sql, eq, desc } from 'drizzle-orm';
import { ceos, journalEntries, cycles, transcripts, rawInputs } from '../src/db/schema';

async function main() {
  const sqlClient = neon(process.env.DATABASE_URL!);
  const db = drizzle(sqlClient);

  // CEOs with intake profile
  const withProfile = await db
    .select({ id: ceos.id, name: ceos.name })
    .from(ceos)
    .where(isNotNull(ceos.profileJson));
  console.log(`CEOs with profile_json (intake): ${withProfile.length}`);
  for (const r of withProfile) console.log(`  ${r.name}`);

  // CEOs with 10x goal
  const withGoal = await db
    .select({ name: ceos.name, goal: ceos.tenXGoal })
    .from(ceos)
    .where(isNotNull(ceos.tenXGoal));
  console.log(`\nCEOs with tenXGoal: ${withGoal.length}`);
  for (const r of withGoal) console.log(`  ${r.name}: ${r.goal?.slice(0, 70)}…`);

  // Projected journal entries
  const projectedJournals = await db
    .select({ count: sql<number>`count(*)` })
    .from(journalEntries)
    .where(isNotNull(journalEntries.sourceRawInputId));
  console.log(`\nProjected journal_entries: ${projectedJournals[0].count}`);

  // Sample journal entries
  const sampleJournals = await db
    .select({
      week: journalEntries.weekNumber,
      title: journalEntries.title,
      cycleLabel: cycles.label,
      ceoName: ceos.name,
    })
    .from(journalEntries)
    .innerJoin(cycles, eq(journalEntries.cycleId, cycles.id))
    .innerJoin(ceos, eq(cycles.ceoId, ceos.id))
    .where(isNotNull(journalEntries.sourceRawInputId))
    .orderBy(desc(journalEntries.createdAt))
    .limit(5);
  console.log(`Sample journal entries:`);
  for (const r of sampleJournals) {
    console.log(`  ${r.ceoName} / ${r.cycleLabel} / Week ${r.week}: "${r.title}"`);
  }

  // Cycles with monthlyReflection
  const cyclesWithReflection = await db
    .select({ count: sql<number>`count(*)` })
    .from(cycles)
    .where(isNotNull(cycles.monthlyReflection));
  console.log(`\nCycles with monthlyReflection: ${cyclesWithReflection[0].count}`);

  // Pending breakdown by reason
  const pending = await db
    .select({ matchCandidates: rawInputs.matchCandidates })
    .from(rawInputs)
    .where(eq(rawInputs.matchStatus, 'pending_ceo'));
  const reasons = pending.reduce((acc, r) => {
    const c = (r.matchCandidates as { reason?: string } | null) ?? {};
    const reason = c.reason ?? 'unknown';
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`\nPending CEO reasons:`, reasons);

  // Pending unique emails
  const uniqEmails = new Set<string>();
  for (const r of pending) {
    const c = (r.matchCandidates as { email?: string } | null) ?? {};
    if (c.email) uniqEmails.add(c.email);
  }
  console.log(`Unique unmatched emails: ${uniqEmails.size}`);
  console.log(`  ${[...uniqEmails].join('\n  ')}`);

  // Transcript projection
  const projectedTranscripts = await db
    .select({ count: sql<number>`count(*)` })
    .from(transcripts)
    .where(isNotNull(transcripts.sourceRawInputId));
  console.log(`\nProjected transcripts (Zoom): ${projectedTranscripts[0].count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
