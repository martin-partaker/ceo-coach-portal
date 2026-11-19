/**
 * Checks for how a reviewer's word on the session stands against the audit on
 * file (src/lib/audit/session-override.ts).
 *
 *   pnpm tsx scripts/check-session-override.ts
 *
 * No database, no credentials. Exits non-zero on a failure.
 */
import { sessionStanding, sessionWords } from '../src/lib/audit/session-override';

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  -> got ${String(got)}, want ${String(want)}`}`);
};

check('nobody has said: the inference stands', sessionStanding(1, null), 'automatic');
check('nobody has said, not placed: still automatic', sessionStanding(null, null), 'automatic');
check('reviewer names the session it was audited as: the audit stands', sessionStanding(1, { sessionNo: 1 }), 'agrees');
check('reviewer names another session: the audit is void', sessionStanding(1, { sessionNo: 3 }), 'superseded');
check('not placed, reviewer says Session 1: waiting to be audited', sessionStanding(null, { sessionNo: 1 }), 'superseded');
check('audited as 1, reviewer says not a numbered session: void', sessionStanding(1, { sessionNo: null }), 'superseded');
check('not placed, reviewer says not a numbered session: nothing to redo', sessionStanding(null, { sessionNo: null }), 'agrees');
check('regenerated as the session she named: stands again', sessionStanding(3, { sessionNo: 3 }), 'agrees');
check('Sessions 4 to 12 share an outline: 5 corrected to 7 still stands', sessionStanding(5, { sessionNo: 7 }), 'agrees');
check('...and 12 corrected to 4', sessionStanding(12, { sessionNo: 4 }), 'agrees');
check('3 corrected to 4 changes the outline: void', sessionStanding(3, { sessionNo: 4 }), 'superseded');
check('4 corrected to 3: void', sessionStanding(4, { sessionNo: 3 }), 'superseded');
check('12 corrected to 13, which has no outline: void', sessionStanding(12, { sessionNo: 13 }), 'superseded');
check('a session of 4-12 said not to be a session: void', sessionStanding(6, { sessionNo: null }), 'superseded');
check('words for a session', sessionWords(3), 'Session 3');
check('words for none', sessionWords(null), 'Not a numbered session');

console.log(failed ? `\n${failed} FAILED` : '\nall pass');
process.exit(failed ? 1 : 0);
