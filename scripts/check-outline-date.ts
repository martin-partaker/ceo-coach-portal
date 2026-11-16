/**
 * Checks for "was this session recorded before its outline is dated?"
 * (outlineMonth / predatesOutline in src/lib/audit/contract.ts).
 *
 *   pnpm tsx scripts/check-outline-date.ts
 *
 * No database, no credentials. Exits non-zero on a failure.
 */
import { outlineMonth, outlineMonthLabel, predatesOutline } from '../src/lib/audit/contract';

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  -> got ${String(got)}, want ${String(want)}`}`);
};

check('month then year', outlineMonthLabel('Session 1 August 2026'), 'August 2026');
check('a word before the month', outlineMonthLabel('Session 3 Final October 2026'), 'October 2026');
// The one that was missed: "a word, then a year" read "Final 2026".
check('a word between month and year', outlineMonthLabel('Sessions 4-12 October Final 2026'), 'October 2026');
check('no date in the name', outlineMonth('Session 9'), null);
check('no name', outlineMonth(null), null);

const aug = { outlineSource: 'Session 2 August 2026' };
check('last second of July: before', predatesOutline(aug, '2026-07-31T23:59:59Z'), true);
check('first second of August: not before', predatesOutline(aug, '2026-08-01T00:00:00Z'), false);
check('a Date works too', predatesOutline(aug, new Date('2026-03-02T10:00:00Z')), true);
check('no recording date: unknown, not "no"', predatesOutline(aug, null), null);
check('no outline: unknown', predatesOutline({}, '2026-03-02T10:00:00Z'), null);
check("the evaluators' answer wins", predatesOutline({ ...aug, predatesOutline: true }, '2026-11-01T00:00:00Z'), true);
check("the evaluators' answer needs no dates", predatesOutline({ predatesOutline: false }, null), false);
check(
  'their "unknown" falls back to the dates',
  predatesOutline({ predatesOutline: null, outlineSource: 'Sessions 4-12 October Final 2026' }, '2026-09-30T10:00:00Z'),
  true,
);

console.log(failed ? `\n${failed} FAILED` : '\nall pass');
process.exit(failed ? 1 : 0);
