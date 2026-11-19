/**
 * How many sessions set by a reviewer are still waiting for their audit.
 *
 *   DATABASE_URL=<branch> pnpm tsx scripts/pending-reviewed.ts
 *
 * Read-only. Prints one line: the count, a space, and a signature of what is
 * waiting ("0 " when nothing is). `scripts/watch-reviewed.sh` polls it.
 *
 * "Waiting" is the same test the screens use (`sessionStanding`): the session
 * a reviewer named is not the one the newest audit of that recording was run
 * as. The signature changes when the set of waiting recordings changes, or
 * one of them is set again — so the watcher can tell "new work" from "the
 * same recording a run has already failed to settle", and not run for ever.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL');
  const sql = neon(process.env.DATABASE_URL);
  const [{ present }] = (await sql`
    SELECT to_regclass('public.transcript_session_overrides') IS NOT NULL AS present
  `) as unknown as { present: boolean }[];
  if (!present) {
    console.log('0 ');
    return;
  }
  const [row] = (await sql`
    SELECT count(*)::int AS n,
           coalesce(md5(string_agg(
             o.transcript_id::text || '|' || coalesce(o.session_no::text, '-') || '|' || o.set_at::text,
             ',' ORDER BY o.transcript_id)), '') AS signature
    FROM transcript_session_overrides o
    LEFT JOIN LATERAL (
      SELECT a.session_no FROM transcript_audits a
      WHERE a.transcript_id = o.transcript_id
      ORDER BY a.generated_at DESC LIMIT 1
    ) la ON true
    WHERE la.session_no IS DISTINCT FROM o.session_no
  `) as unknown as { n: number; signature: string }[];
  console.log(`${row.n} ${row.signature}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
