/**
 * Checks for the first batch a reviewer is offered (src/lib/audit/first-batch.ts).
 *
 *   pnpm tsx scripts/check-first-batch.ts
 *
 * No database, no credentials. Exits non-zero on a failure.
 */
import { coachKey, firstBatch, type BatchRow } from '../src/lib/audit/first-batch';

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const row = (id: string, sessionNo: number | null, coach: string, ceo: string, day: string | null): BatchRow => ({
  id, sessionNo, coach, ceo, recordedAt: day ? `2026-${day}T10:00:00Z` : null,
});

check('a title after the comma is not another coach', coachKey('Jim Peduto, ScaleOS 10x Coach'), 'Jim Peduto');
check('no label', coachKey(null), 'Unknown coach');

const s1 = [
  row('a', 1, 'Coach A', 'Ann', '09-01'),
  row('b', 1, 'Coach A', 'Bob', '09-20'),          // newest
  row('c', 1, 'Coach B, ScaleOS 10x Coach', 'Cy', '09-10'),
  row('d', 1, 'Coach C', 'Di', '08-01'),
];
check('Session 1: the two newest, one per coach', firstBatch(s1), ['b', 'c']);

check('the same day: the id decides, whatever order the rows arrive in',
  firstBatch([row('z', 2, 'Coach A', 'Ann', '09-01'), row('y', 2, 'Coach B', 'Bob', '09-01')]),
  firstBatch([row('y', 2, 'Coach B', 'Bob', '09-01'), row('z', 2, 'Coach A', 'Ann', '09-01')]));

const later = [
  row('e', 5, 'Coach A', 'Ann', '11-05'),
  row('f', 6, 'Coach A', 'Bob', '11-04'),
  row('g', 7, 'Coach A', 'Cy', '11-03'),            // a third for Coach A: left out
  row('h', 4, 'Coach B', 'Di', '10-01'),
  row('i', 9, 'Coach B', 'Di', '09-01'),            // the same CEO again: left out
  row('j', 12, 'Coach C', 'Ed', '08-01'),
  row('k', 13, 'Coach C', 'Flo', '11-10'),          // no outline for Session 13
  row('l', null, 'Coach C', 'Gus', '11-11'),        // not placed
  row('m', 8, 'Coach C', 'Hal', null),              // no date: cannot be "recent"
];
check('Sessions 4-12: two per coach, no CEO twice, only sessions with an outline and a date',
  firstBatch(later), ['e', 'f', 'h', 'j']);

check('no CEO twice across session types either; partners count as both',
  firstBatch([row('p', 1, 'Coach A', 'Ann & Bo', '09-01'), row('q', 2, 'Coach B', 'Bo', '10-01'),
              row('r', 2, 'Coach C', 'Cy', '09-15')]),
  ['p', 'r']);

const many = Array.from({ length: 12 }, (_, n) =>
  row(`x${n}`, 4 + (n % 9), `Coach ${'ABCD'[n % 4]}`, `Ceo ${n}`, `10-${String(10 + n)}`));
check('never more than six from Sessions 4-12', firstBatch(many).length, 6);
check('nothing to choose from', firstBatch([]), []);

console.log(failed ? `\n${failed} FAILED` : '\nall pass');
process.exit(failed ? 1 : 0);
