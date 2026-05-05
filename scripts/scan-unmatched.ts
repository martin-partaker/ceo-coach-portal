/**
 * Search raw_inputs (zoom transcripts + tally submissions) for any
 * mention of CEOs that weren't auto-matched, and report which coach
 * the data came from. Read-only.
 *
 * Run: pnpm exec tsx --env-file=.env scripts/scan-unmatched.ts
 */
import 'dotenv/config';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../src/db';
import { rawInputs, coaches } from '../src/db/schema';

const TARGETS = [
  { name: 'John Murrow', tokens: ['john murrow', 'murrow', 'jmurrow', 'trailhead'], email: 'jmurrow@trailheadmedia.com' },
  { name: 'David A Dieter', tokens: ['dieter', 'wicoil', 'ddieter'], email: 'ddieter@wicoil.com' },
  { name: 'Chris (Connolly?)', tokens: ['aconnollyltd', 'aconnolly'], email: 'chris@aconnollyltd.co.uk' },
  { name: 'Dawn Donnelly', tokens: ['donnelly', 'dawn8015'], email: 'dawn8015@gmail.com' },
  { name: 'John Murigu', tokens: ['murigu', 'murigujn'], email: 'murigujn@gmail.com' },
  { name: 'Satish Peddada', tokens: ['peddada', 'satish', 'strategystackconsulting'], email: 'satish.peddada@strategystackconsulting.com' },
];

async function main() {
  const allCoaches = await db.select().from(coaches);
  const coachById = new Map(allCoaches.map(c => [c.id, c.email]));

  const all = await db.select().from(rawInputs);
  console.log(`Scanning ${all.length} raw_inputs for ${TARGETS.length} unmatched CEOs...\n`);

  for (const target of TARGETS) {
    const matches = [];
    for (const row of all) {
      const blob = JSON.stringify(row.payloadJson ?? '').toLowerCase()
        + '\n' + (row.textContent ?? '').toLowerCase();
      const hits = target.tokens.filter(t => blob.includes(t));
      if (hits.length === 0) continue;
      matches.push({ row, hits });
    }
    console.log(`=== ${target.name} ===`);
    if (matches.length === 0) {
      console.log('  (no mentions in raw_inputs)\n');
      continue;
    }
    // Aggregate by coach
    const byCoach = new Map();
    for (const m of matches) {
      const coachEmail = m.row.coachId ? coachById.get(m.row.coachId) ?? `unknown(${m.row.coachId.slice(0,8)})` : '(no coach)';
      byCoach.set(coachEmail, (byCoach.get(coachEmail) || 0) + 1);
    }
    for (const [coach, count] of [...byCoach.entries()].sort((a,b) => b[1] - a[1])) {
      console.log(`  ${count}x  via coach ${coach}`);
    }
    // Show a few sample meetings/topics
    console.log('  sample raw_input rows:');
    for (const m of matches.slice(0, 5)) {
      const payload = m.row.payloadJson as {
        topic?: string;
        formName?: string;
        meeting?: { topic?: string };
        start_time?: string;
        submittedAt?: string;
      } | null;
      const topic = payload?.topic ?? payload?.formName ?? payload?.meeting?.topic ?? '(no topic)';
      const start = payload?.start_time ?? payload?.submittedAt ?? m.row.occurredAt;
      console.log(`    · [${m.row.source}/${m.row.matchStatus}] ${String(start).slice(0,10)}  ${topic}  (hits: ${m.hits.join(',')})`);
    }
    console.log();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
