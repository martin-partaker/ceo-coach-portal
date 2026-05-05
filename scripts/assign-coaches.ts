/**
 * Assign coaches to CEOs based on transcript-derived pairings.
 * Idempotent — safe to re-run. Only updates ceos.coach_id.
 *
 * Run: pnpm exec tsx --env-file=.env scripts/assign-coaches.ts
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { ceos, ceoEmailAliases, coaches } from '../src/db/schema';

// CEO primary email → coach email
const PAIRINGS: Record<string, string> = {
  // Eric
  'mark.cooper@prairiecleanenterprises.com': 'eric@partaker.com',
  'rasmus@meetstardust.ai': 'eric@partaker.com',
  'david.harding@tiptonmills.com': 'eric@partaker.com',
  'rashad@ryzesuperfoods.com': 'eric@partaker.com',
  'ddieter@wicoil.com': 'eric@partaker.com',
  'jmurrow@trailheadmedia.com': 'eric@partaker.com',
  // Steve
  'probinson@homeoftheinnocents.org': 'steve@partaker.com',
  'ivan@audiolibrix.com': 'steve@partaker.com',
  'nicole@foxtrot-services.com': 'steve@partaker.com',
  'milos.jankovic@koretrust.com': 'steve@partaker.com',
  'cfinlay@lloydjonesllc.com': 'steve@partaker.com',
  'tmaisiri@fh.org': 'steve@partaker.com',
  'nicolecooper@squarerigger.com': 'steve@partaker.com',
  // Mark Roberts
  'jp.gehrig@acp.io': 'mark@partaker.com',
  'jamesdosullivan@outlook.com': 'mark@partaker.com',
  'jayne@glowcroft.co.uk': 'mark@partaker.com',
  'goolshun.belut@smplicity.mu': 'mark@partaker.com',
  // Grant
  'lmartin@clinomic.ai': 'grant@partaker.com',
  'jahmad@aprosoft.com': 'grant@partaker.com',
  'isntang@gmail.com': 'grant@partaker.com',
  'dgross@bouncebackhomes.com': 'grant@partaker.com',
  'murigujn@gmail.com': 'grant@partaker.com',
};

async function main() {
  console.log(`→ Assigning coaches for ${Object.keys(PAIRINGS).length} CEOs\n`);

  // Resolve coach emails → ids once
  const coachIdByEmail = new Map<string, string>();
  for (const coachEmail of new Set(Object.values(PAIRINGS))) {
    const [c] = await db
      .select({ id: coaches.id })
      .from(coaches)
      .where(eq(coaches.email, coachEmail))
      .limit(1);
    if (!c) {
      console.error(`  ✗ coach not found: ${coachEmail}`);
      process.exit(1);
    }
    coachIdByEmail.set(coachEmail, c.id);
  }

  let updated = 0;
  let alreadyCorrect = 0;
  let missing = 0;

  for (const [ceoEmail, coachEmail] of Object.entries(PAIRINGS)) {
    const targetCoachId = coachIdByEmail.get(coachEmail)!;

    // Resolve CEO via alias (canonical lookup path)
    const [alias] = await db
      .select({ ceoId: ceoEmailAliases.ceoId })
      .from(ceoEmailAliases)
      .where(eq(ceoEmailAliases.email, ceoEmail))
      .limit(1);
    if (!alias) {
      console.log(`  ?  ${ceoEmail.padEnd(45)} → CEO not found (skipped)`);
      missing++;
      continue;
    }

    const [current] = await db
      .select({ id: ceos.id, name: ceos.name, coachId: ceos.coachId })
      .from(ceos)
      .where(eq(ceos.id, alias.ceoId))
      .limit(1);

    if (!current) {
      console.log(`  ?  ${ceoEmail.padEnd(45)} → CEO row missing (skipped)`);
      missing++;
      continue;
    }

    if (current.coachId === targetCoachId) {
      console.log(`  ·  ${current.name.padEnd(22)} already → ${coachEmail}`);
      alreadyCorrect++;
      continue;
    }

    await db.update(ceos).set({ coachId: targetCoachId }).where(eq(ceos.id, current.id));
    console.log(`  ✓  ${current.name.padEnd(22)} → ${coachEmail}`);
    updated++;
  }

  console.log(
    `\n✅ Done — updated ${updated}, already correct ${alreadyCorrect}, missing ${missing}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
