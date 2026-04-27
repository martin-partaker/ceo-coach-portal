/**
 * Backfill ceo_email_aliases from existing ceos.email values.
 * Run: pnpm tsx --env-file=.env scripts/backfill-aliases.ts
 *
 * Idempotent — safe to re-run.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { isNotNull } from 'drizzle-orm';
import { ceos, ceoEmailAliases } from '../src/db/schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFC');
}

async function main() {
  const rows = await db
    .select({ id: ceos.id, email: ceos.email })
    .from(ceos)
    .where(isNotNull(ceos.email));

  let inserted = 0;
  let skipped = 0;
  let invalid = 0;

  for (const row of rows) {
    if (!row.email) {
      invalid++;
      continue;
    }
    const email = normalizeEmail(row.email);
    if (!email.includes('@')) {
      invalid++;
      continue;
    }

    try {
      await db
        .insert(ceoEmailAliases)
        .values({ ceoId: row.id, email })
        .onConflictDoNothing({ target: ceoEmailAliases.email });
      inserted++;
    } catch (err) {
      console.error(`Failed for ceo ${row.id} (${email}):`, err);
      skipped++;
    }
  }

  console.log(
    `Backfill complete — ceos with email: ${rows.length}, alias upserts: ${inserted}, errors: ${skipped}, invalid: ${invalid}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
