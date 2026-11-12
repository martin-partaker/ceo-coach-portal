/**
 * Checks for the rule that carries a reviewer's answers from one audit of a
 * session to the next (src/lib/audit/feedback-carry.ts).
 *
 *   pnpm tsx scripts/check-feedback-carry.ts
 *
 * No database and no credentials: the rule is a pure function. The repo has
 * no test runner, so this is a script that exits non-zero on a failure.
 *
 * The cases that matter most are the refusals. Showing an old "agree" under a
 * finding that now says something else would be worse than showing nothing.
 */
import { feedbackFor, type EarlierAnswer, type StoredAnswer } from '../src/lib/audit/feedback-carry';
import type { AuditFinding, AuditResult } from '../src/lib/audit/contract';

let failed = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  -> ${JSON.stringify(info)}`}`);
};

const finding = (o: Partial<AuditFinding> = {}): AuditFinding => ({
  id: 'goal.challenged',
  step: '3.2',
  name: 'The coach questions the goal figure',
  family: 'B',
  verdict: 'review',
  detail: 'd',
  basis: 'source',
  restsOn: 'x',
  severity: null,
  evidence: [{ line: 10, lineEnd: 12 }],
  notAssessed: false,
  ...o,
});
const answer = (o: Partial<StoredAnswer> = {}): StoredAnswer => ({
  findingId: 'goal.challenged',
  findingStep: '3.2',
  verdict: 'disagree',
  reason: 'false_finding',
  note: 'He does ask',
  coachId: 'me',
  coachName: 'Reviewer One',
  updatedAt: new Date('2026-11-13T10:00:00Z'),
  ...o,
});
const earlier = (o: Partial<EarlierAnswer> = {}): EarlierAnswer => ({
  ...answer(),
  auditId: 'a1',
  criteriaVersion: 'v1',
  generatedAt: new Date('2026-11-12T10:00:00Z'),
  ...o,
});
const audit = (findings: AuditFinding[], sha = 'S') =>
  ({ contentSha256: sha, findings }) as unknown as AuditResult;
const run = (o: {
  finding?: AuditFinding;
  current?: StoredAnswer[];
  earlier?: EarlierAnswer[];
  earlierAudits?: Map<string, AuditResult | null>;
}) =>
  feedbackFor({
    finding: o.finding ?? finding(),
    viewerId: 'me',
    contentSha256: 'S',
    current: o.current ?? [],
    earlier: o.earlier ?? [],
    earlierAudits: o.earlierAudits ?? new Map(),
  });
const one = (f: AuditFinding | null, sha = 'S') =>
  new Map<string, AuditResult | null>([['a1', f ? audit([f], sha) : null]]);

let r = run({});
check('nothing anywhere: no answer, nothing carried',
  r.mine === null && r.others.length === 0 && r.carried.mine === null && r.carried.others.length === 0, r);

r = run({ earlier: [earlier()], earlierAudits: one(finding()) });
check('same claim: carried over, and it stands',
  r.mine === null && r.carried.mine?.stillStands === true && r.carried.mine.fromCriteria === 'v1' &&
  r.carried.mine.note === 'He does ask', r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(finding({ detail: 'reworded explanation' })) });
check('only the explanation reworded: still stands', r.carried.mine?.stillStands === true, r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(finding({ verdict: 'ok' })) });
check('verdict changed: shown as said then, not applied',
  r.carried.mine?.stillStands === false && r.carried.mine.changes.join() === 'verdict' &&
  r.carried.mine.was === 'ok', r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(finding({ notAssessed: true })) });
check('was not assessed, now assessed: a verdict change',
  r.carried.mine?.stillStands === false && r.carried.mine.was === 'notAssessed', r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(finding({ evidence: [{ line: 10 }] })) });
check('a different passage is quoted: not applied',
  r.carried.mine?.stillStands === false && r.carried.mine.changes.join() === 'quote', r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(finding(), 'OTHER') });
check('the transcript changed: not applied, line numbers not compared',
  r.carried.mine?.stillStands === false && r.carried.mine.changes.join() === 'transcript', r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(finding({ name: 'A different claim' })) });
check('renamed: not applied',
  r.carried.mine?.stillStands === false && r.carried.mine.changes.join() === 'wording', r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(null) });
check('earlier audit unreadable: unknown, never treated as unchanged',
  r.carried.mine?.stillStands === false && r.carried.mine.changes.join() === 'unknown' &&
  r.carried.mine.was === null, r.carried);

r = run({ earlier: [earlier()], earlierAudits: one(finding({ step: '3.1' })) });
check('finding absent from the earlier audit: unknown', r.carried.mine?.changes.join() === 'unknown', r.carried);

r = run({
  current: [answer({ verdict: 'agree', reason: null, note: null })],
  earlier: [earlier()], earlierAudits: one(finding()),
});
check('answered on this audit: that is the answer, nothing carried',
  r.mine?.verdict === 'agree' && r.carried.mine === null, r);

r = run({
  current: [answer({ verdict: 'withdrawn', reason: null, note: null })],
  earlier: [earlier()], earlierAudits: one(finding()),
});
check('withdrawn on this audit: no answer, and nothing carried', r.mine === null && r.carried.mine === null, r);

const two = new Map<string, AuditResult | null>([['a1', audit([finding()])], ['a2', audit([finding()])]]);
r = run({
  earlier: [
    earlier(),
    earlier({ auditId: 'a2', criteriaVersion: 'v2', verdict: 'agree', reason: null,
              generatedAt: new Date('2026-11-12T12:00:00Z') }),
  ],
  earlierAudits: two,
});
check('two earlier answers: the newest audit wins',
  r.carried.mine?.verdict === 'agree' && r.carried.mine.fromCriteria === 'v2', r.carried);

r = run({
  earlier: [
    earlier(),
    earlier({ auditId: 'a2', criteriaVersion: 'v2', verdict: 'withdrawn',
              generatedAt: new Date('2026-11-12T12:00:00Z') }),
  ],
  earlierAudits: two,
});
check('her last word was a withdrawal: the older answer does not come back', r.carried.mine === null, r.carried);

r = run({
  earlier: [earlier({ coachId: 'two', coachName: 'Reviewer Two', verdict: 'agree', reason: null, note: null })],
  earlierAudits: one(finding()),
});
check('another reviewer: carried under the others, never as mine',
  r.carried.mine === null && r.carried.others.length === 1 &&
  r.carried.others[0].coachName === 'Reviewer Two' && r.carried.others[0].stillStands, r.carried);

r = run({
  current: [answer({ coachId: 'two', coachName: 'Reviewer Two', verdict: 'agree', reason: null, note: null })],
  earlier: [earlier()], earlierAudits: one(finding()),
});
check('someone else answered here: mine is still carried',
  r.mine === null && r.others.length === 1 && r.carried.mine?.stillStands === true, r);

r = run({ earlier: [earlier({ findingId: 'lang.scaleos', findingStep: '' })], earlierAudits: one(finding()) });
check('an answer to another finding is not carried here', r.carried.mine === null, r.carried);

r = run({
  finding: finding({ step: null }),
  earlier: [earlier({ findingStep: '' })],
  earlierAudits: one(finding({ step: null })),
});
check('a finding with no step matches on the empty step', r.carried.mine?.stillStands === true, r.carried);

console.log(failed ? `\n${failed} FAILED` : '\nall pass');
process.exit(failed ? 1 : 0);
