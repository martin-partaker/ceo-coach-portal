/**
 * Seed real CEOs + cycles for testing ingestion against the local
 * tally-data/ and transcripts/ caches. Idempotent — safe to re-run.
 *
 * Assigns all CEOs to the coach martin@partaker.com (whose zoomUserEmail
 * is eric@partaker.com, so Eric-hosted transcripts match this coach).
 *
 * Run: pnpm seed:test-data
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, and } from 'drizzle-orm';
import { coaches, ceos, ceoEmailAliases, cycles } from '../src/db/schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

interface SeedCeo {
  name: string;
  email: string;
  aliases?: string[]; // additional emails to map to this CEO
  tenXGoal?: string;
  note?: string;
}

/**
 * Names + emails grounded in the real Tally/Zoom data.
 *   - "Exact match" rows resolve cleanly via Tally email and Zoom name.
 *   - "Fuzzy" rows differ from the transcript's participant.name on purpose
 *     so the fuzzy matcher / pending queue / coach-confirm flow get exercised.
 *   - "Group" rows participate together in the David Harding + Dave Snyder
 *     kickoff transcript so the coaching_group classifier path is hit.
 */
const SEED_CEOS: SeedCeo[] = [
  {
    name: 'Milos Jankovic',
    email: 'milos.jankovic@koretrust.com',
    tenXGoal: 'Scale KoreTrust to $50M ARR within 3 years',
    note: 'Exact match — high-volume Tally + Zoom data',
  },
  {
    name: 'Rasmus Sanne',
    email: 'rasmus@meetstardust.ai',
    tenXGoal: 'Reach unicorn valuation with Stardust',
    note: 'Exact match — kickoff transcript + 5 weekly journals',
  },
  {
    name: 'Mark Cooper',
    email: 'mark.cooper@prairiecleanenterprises.com',
    tenXGoal: '10x Prairie Clean revenue',
    note: 'Exact match — kickoff transcript',
  },
  {
    name: 'David Dieter', // Zoom transcript says "Dave Dieter" → fuzzy
    email: 'ddieter@wicoil.com',
    tenXGoal: 'Grow WIC Oil revenue and team capacity',
    note: 'Fuzzy: transcript participant is "Dave Dieter"',
  },
  {
    name: 'David Harding',
    email: 'david.harding@tiptonmills.com',
    tenXGoal: 'Tipton Mills 10x growth',
    note: 'Group session w/ Dave Snyder (kickoff)',
  },
  {
    name: 'Dave Snyder',
    email: 'dave.snyder@tiptonmills.com',
    tenXGoal: 'Tipton Mills 10x growth (cofounder)',
    note: 'Group session w/ David Harding',
  },
  {
    name: 'Rashad Hossain',
    email: 'rashad@ryzewith.com',
    tenXGoal: 'Scale Ryze',
    note: 'Exact match — kickoff transcript',
  },
  {
    name: 'Jean-Pierre Gehrig',
    email: 'jp.gehrig@acp.io',
    aliases: ['jean.pierre.gehrig@acp.io'], // demonstrate alias resolution
    tenXGoal: 'ACP 10x revenue',
    note: 'Has 10x goal session transcript; also tests email aliases',
  },
  {
    name: 'Paul Robinson',
    email: 'probinson@homeoftheinnocents.org',
    tenXGoal: 'Expand Home of the Innocents impact',
    note: 'Exact match — 5 weekly journals',
  },
  {
    name: 'John Murrow',
    email: 'jmurrow@trailheadmedia.com',
    tenXGoal: 'Trailhead Media 10x',
    note: 'Exact match — 5 weekly journals',
  },
  {
    name: 'Chris Finlay',
    email: 'cfinlay@lloydjonesllc.com',
    tenXGoal: 'Lloyd Jones 10x',
    note: 'Transcripts have "Chris Finlay" exact; Tally has "Chris" only — single-name lookup',
  },
  {
    name: 'Ivan Sabo',
    email: 'ivan@audiolibrix.com',
    tenXGoal: 'Audiolibrix scale-up',
    note: 'Fuzzy single-name: some Tally entries say just "Ivan"',
  },
  {
    name: 'Donald Gross',
    email: 'dgross@bouncebackhomes.com',
    tenXGoal: 'Bounceback Homes 10x',
    note: 'Tally also has "Donald K Gross" — name variant',
  },
  {
    name: 'Trevor Maisiri',
    email: 'tmaisiri@fh.org',
    tenXGoal: 'FH global expansion',
    note: 'Has Zoom transcript',
  },
  {
    name: 'Goolshun Belut',
    email: 'goolshun.belut@smplicity.mu',
    tenXGoal: 'Smplicity Mauritius growth',
    note: 'Exact match',
  },
  {
    name: 'Dawn Donnelly',
    email: 'dmd@amplifyorghealth.com',
    tenXGoal: 'Amplify Org Health 10x',
    note: 'One Tally submission',
  },
];

// 2026 monthly cycles covering all the local test data.
const CYCLES = [
  { label: 'Feb 2026', periodStart: '2026-02-01', periodEnd: '2026-02-28' },
  { label: 'Mar 2026', periodStart: '2026-03-01', periodEnd: '2026-03-31' },
  { label: 'Apr 2026', periodStart: '2026-04-01', periodEnd: '2026-04-30' },
];

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFC');
}

async function getMartinCoach(): Promise<{ id: string; email: string }> {
  const [martin] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.email, 'martin@partaker.com'))
    .limit(1);
  if (!martin) {
    throw new Error('Coach martin@partaker.com not found — sign in first to create the account.');
  }
  return { id: martin.id, email: martin.email };
}

async function ensureCeo(coachId: string, seed: SeedCeo): Promise<{ ceoId: string; created: boolean }> {
  const primaryEmail = normalizeEmail(seed.email);

  // Look up by alias first (the canonical lookup path)
  const [existingAlias] = await db
    .select()
    .from(ceoEmailAliases)
    .where(eq(ceoEmailAliases.email, primaryEmail))
    .limit(1);

  if (existingAlias) {
    // Make sure all aliases are present
    for (const alias of seed.aliases ?? []) {
      const a = normalizeEmail(alias);
      await db
        .insert(ceoEmailAliases)
        .values({ ceoId: existingAlias.ceoId, email: a })
        .onConflictDoNothing({ target: ceoEmailAliases.email });
    }
    return { ceoId: existingAlias.ceoId, created: false };
  }

  const [created] = await db
    .insert(ceos)
    .values({
      coachId,
      name: seed.name,
      email: primaryEmail,
      tenXGoal: seed.tenXGoal,
      tenXGoalUpdatedAt: seed.tenXGoal ? new Date() : null,
    })
    .returning();

  await db
    .insert(ceoEmailAliases)
    .values({ ceoId: created.id, email: primaryEmail })
    .onConflictDoNothing({ target: ceoEmailAliases.email });

  for (const alias of seed.aliases ?? []) {
    const a = normalizeEmail(alias);
    await db
      .insert(ceoEmailAliases)
      .values({ ceoId: created.id, email: a })
      .onConflictDoNothing({ target: ceoEmailAliases.email });
  }

  return { ceoId: created.id, created: true };
}

async function ensureCycle(
  ceoId: string,
  cycle: { label: string; periodStart: string; periodEnd: string }
): Promise<{ created: boolean }> {
  const [existing] = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(
        eq(cycles.ceoId, ceoId),
        eq(cycles.label, cycle.label),
        eq(cycles.periodStart, cycle.periodStart)
      )
    )
    .limit(1);

  if (existing) return { created: false };

  await db.insert(cycles).values({
    ceoId,
    label: cycle.label,
    periodStart: cycle.periodStart,
    periodEnd: cycle.periodEnd,
  });
  return { created: true };
}

async function main() {
  console.log('→ Seeding test data');

  const martin = await getMartinCoach();
  console.log(`  coach: ${martin.email} (${martin.id})`);

  let ceosCreated = 0;
  let ceosExisted = 0;
  let cyclesCreated = 0;
  let cyclesExisted = 0;

  for (const seed of SEED_CEOS) {
    const { ceoId, created } = await ensureCeo(martin.id, seed);
    if (created) ceosCreated++;
    else ceosExisted++;

    for (const cy of CYCLES) {
      const { created: cycleCreated } = await ensureCycle(ceoId, cy);
      if (cycleCreated) cyclesCreated++;
      else cyclesExisted++;
    }

    console.log(`  ${created ? '✓' : '·'} ${seed.name.padEnd(22)} <${seed.email}>  ${seed.note ?? ''}`);
  }

  console.log(
    `\n✅ Seed complete — CEOs: +${ceosCreated} new (${ceosExisted} existing), Cycles: +${cyclesCreated} new (${cyclesExisted} existing)`
  );
  console.log(`\nNext: pnpm backfill:tally --live   (then) pnpm backfill:zoom`);
  console.log(`Then open http://localhost:3000/admin/inbox to review.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
