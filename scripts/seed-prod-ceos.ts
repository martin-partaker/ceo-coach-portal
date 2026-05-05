/**
 * Seed production CEOs from the ScaleOS 10x roster. Idempotent — safe to re-run.
 *
 * After running, re-run `pnpm backfill:zoom --live` and `pnpm backfill:tally --live`
 * so previously-pending raw_inputs match against the new CEOs.
 *
 * Usage:
 *   pnpm seed:prod-ceos                       # CEOs created unassigned
 *   pnpm seed:prod-ceos --coach eric@partaker.com   # all assigned to that coach
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { coaches, ceos, ceoEmailAliases } from '../src/db/schema';

interface SeedCeo {
  name: string;
  email: string;
  aliases?: string[];
}

const SEED_CEOS: SeedCeo[] = [
  { name: 'Mark Cooper', email: 'mark.cooper@prairiecleanenterprises.com' },
  { name: 'Paul Robinson', email: 'probinson@homeoftheinnocents.org' },
  { name: 'John Murrow', email: 'jmurrow@trailheadmedia.com' },
  { name: 'Lukas Martin', email: 'lmartin@clinomic.ai' },
  { name: 'Rasmus Sanne', email: 'rasmus@meetstardust.ai' },
  { name: 'Ivan Sabo', email: 'ivan@audiolibrix.com' },
  { name: 'Nicole Sanders', email: 'nicole@foxtrot-services.com' },
  { name: 'Milos Jankovic', email: 'milos.jankovic@koretrust.com' },
  { name: 'Chris Finlay', email: 'cfinlay@lloydjonesllc.com' },
  { name: 'David Harding', email: 'david.harding@tiptonmills.com' },
  { name: 'Jean-Pierre Gehrig', email: 'jp.gehrig@acp.io' },
  { name: 'Rashad Hossain', email: 'rashad@ryzesuperfoods.com' },
  { name: 'Javed Ahmad', email: 'jahmad@aprosoft.com' },
  { name: "James O'Sullivan", email: 'jamesdosullivan@outlook.com' },
  { name: 'David A Dieter', email: 'ddieter@wicoil.com' },
  { name: 'Ivan Tang', email: 'isntang@gmail.com' },
  { name: 'Trevor Maisiri', email: 'tmaisiri@fh.org' },
  { name: 'Nicole Cooper', email: 'nicolecooper@squarerigger.com' },
  { name: 'Chris', email: 'chris@aconnollyltd.co.uk' },
  { name: 'Jayne Tarrant', email: 'jayne@glowcroft.co.uk' },
  { name: 'Donald Gross', email: 'dgross@bouncebackhomes.com' },
  { name: 'Goolshun Belut', email: 'goolshun.belut@smplicity.mu' },
  { name: 'Dawn Donnelly', email: 'dawn8015@gmail.com' },
  { name: 'John Murigu', email: 'murigujn@gmail.com' },
  { name: 'Satish Peddada', email: 'satish.peddada@strategystackconsulting.com' },
];

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFC');
}

function parseCoachArg(): string | null {
  const idx = process.argv.indexOf('--coach');
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--coach requires an email argument, e.g. --coach eric@partaker.com');
  }
  return normalizeEmail(value);
}

async function resolveCoachId(coachEmail: string | null): Promise<string | null> {
  if (!coachEmail) return null;
  const [coach] = await db
    .select({ id: coaches.id, email: coaches.email })
    .from(coaches)
    .where(eq(coaches.email, coachEmail))
    .limit(1);
  if (!coach) {
    throw new Error(
      `Coach with email "${coachEmail}" not found. Existing coaches must sign in (or be auto-created via backfill) before being referenced.`
    );
  }
  return coach.id;
}

async function ensureCeo(
  coachId: string | null,
  seed: SeedCeo
): Promise<{ ceoId: string; created: boolean }> {
  const primaryEmail = normalizeEmail(seed.email);
  const aliasEmails = (seed.aliases ?? []).map(normalizeEmail);

  const [existingAlias] = await db
    .select()
    .from(ceoEmailAliases)
    .where(eq(ceoEmailAliases.email, primaryEmail))
    .limit(1);

  let ceoId: string;
  let created: boolean;

  if (existingAlias) {
    ceoId = existingAlias.ceoId;
    created = false;
  } else {
    const [row] = await db
      .insert(ceos)
      .values({ coachId, name: seed.name, email: primaryEmail })
      .returning();
    ceoId = row.id;
    created = true;

    await db
      .insert(ceoEmailAliases)
      .values({ ceoId, email: primaryEmail })
      .onConflictDoNothing({ target: ceoEmailAliases.email });
  }

  for (const alias of aliasEmails) {
    await db
      .insert(ceoEmailAliases)
      .values({ ceoId, email: alias })
      .onConflictDoNothing({ target: ceoEmailAliases.email });
  }

  return { ceoId, created };
}

async function main() {
  const coachEmail = parseCoachArg();
  const coachId = await resolveCoachId(coachEmail);

  console.log('→ Seeding production CEOs');
  console.log(`  coach assignment: ${coachEmail ?? '(unassigned)'}`);
  console.log(`  count: ${SEED_CEOS.length}\n`);

  let createdCount = 0;
  let existedCount = 0;

  for (const seed of SEED_CEOS) {
    const { created } = await ensureCeo(coachId, seed);
    if (created) createdCount++;
    else existedCount++;
    console.log(`  ${created ? '✓' : '·'} ${seed.name.padEnd(24)} <${seed.email}>`);
  }

  console.log(
    `\n✅ Seed complete — CEOs: +${createdCount} new, ${existedCount} already existed`
  );
  console.log('\nNext:');
  console.log('  pnpm backfill:zoom --live');
  console.log('  pnpm backfill:tally --live');
  console.log('  Then resolve any remaining pending items in /admin/inbox');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
