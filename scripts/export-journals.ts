/**
 * Dump the CEOs' weekly Momentum Journal entries for the Python evaluators.
 *
 *   DATABASE_URL=<branch> pnpm tsx scripts/export-journals.ts --out journals.json
 *
 * Read-only. Writes one JSON file: [{ ceo, at, title, week, content }], oldest
 * first per CEO. `tool/model_read_session.py` reads a session beside the
 * entries its CEO filed since the previous session, to say whether the coach
 * used them. `scripts/regenerate-audits.sh` runs this with the rest.
 *
 * Like `export-audit-input.ts`, this exports facts and decides nothing: which
 * entries belong to which session is a rule over dates, and it lives with the
 * other rules, in the evaluators.
 *
 * Measured rather than assumed, on the 305 entries on staging (17 Nov 2026):
 *
 * WHO wrote an entry is `raw_inputs.ceo_id` — the CEO the Tally submission was
 * matched to, by email, set on all 305. Not `journal_entries.authored_by_ceo_id`
 * (NULL on 66), and not the CEO of the entry's cycle: two partners who are
 * coached together share cycles, and 10 entries sit under the other partner's.
 *
 * WHEN is `raw_inputs.occurred_at`, which is Tally's `submittedAt` on every
 * row. `journal_entries.entry_date` is NULL on every row and `created_at` is
 * when the portal ingested it. `occurred_at` has no time zone and holds UTC;
 * it is written out as UTC here, in SQL, so the machine's own zone never
 * enters into it.
 *
 * The file holds the CEOs' own writing. It stays on the machine it was
 * written on.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const args = process.argv.slice(2);
const outPath = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'journals.json';
})();

type Row = {
  ceo: string;
  at: string;
  title: string | null;
  week: number | null;
  content: string;
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL');
  const sql = neon(process.env.DATABASE_URL);

  const rows = (await sql`
    SELECT c.name AS ceo,
           to_char(r.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
           je.title, je.week_number AS week, je.content
    FROM journal_entries je
    JOIN raw_inputs r ON r.id = je.source_raw_input_id
    JOIN ceos c       ON c.id = r.ceo_id
    WHERE r.occurred_at IS NOT NULL AND je.content IS NOT NULL
    ORDER BY c.name, r.occurred_at
  `) as unknown as Row[];

  // Entries that cannot be used, counted so their absence is never silent.
  const [{ n: total }] = (await sql`
    SELECT count(*)::int AS n FROM journal_entries
  `) as unknown as { n: number }[];

  writeFileSync(outPath, JSON.stringify(rows, null, 1));
  const ceos = new Set(rows.map((r) => r.ceo));
  const dates = rows.map((r) => r.at.slice(0, 10)).sort();
  console.log(
    `${rows.length} journal entries of ${ceos.size} CEOs -> ${outPath}` +
      (dates.length > 0 ? ` (${dates[0]} to ${dates[dates.length - 1]})` : ''),
  );
  if (total !== rows.length) {
    console.log(
      `  ${total - rows.length} more could not be used: no matched CEO, no submission date, or no text`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
