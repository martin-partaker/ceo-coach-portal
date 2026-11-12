import { findingStepKey, type AuditFinding, type AuditResult } from './contract';

/**
 * Carrying a reviewer's answers from one audit of a session to the next.
 *
 * An answer is stored against the exact audit it was given on, and that stays
 * true: a disagreement is about the verdict those criteria produced. But
 * audits are regenerated whenever a criterion is corrected, and a reviewer
 * who answered thirty sessions must not come back to thirty blank ones.
 *
 * So nothing is copied. When an audit is shown, each finding without an
 * answer on this audit looks back for the same reviewer's latest answer to
 * the same finding on an earlier audit of the same recording, and asks one
 * question: is it still the same claim?
 *
 *  - Same verdict, same wording, same quoted lines of the same transcript:
 *    the answer stands, and is shown as hers, marked as carried over.
 *  - Anything else: the answer is shown as what she said THEN, with what has
 *    changed, and the finding is put to her again. An "agree" given to one
 *    claim is never presented as agreement with another.
 *
 * `detail` is deliberately not part of the comparison. It is explanatory
 * text that gets reworded without the claim changing; the claim is the
 * verdict, the name it goes by, and the passage it rests on.
 */

/**
 * Stored on an audit when the reviewer takes back an answer that was being
 * carried over. Deleting would not do it — there is nothing on this audit to
 * delete, and the earlier answer belongs to the earlier audit. This says "no
 * answer here, and do not bring the old one forward". Never offered as a
 * choice and never shown as an answer.
 */
export const FEEDBACK_WITHDRAWN = 'withdrawn';

export type ClaimChange = 'verdict' | 'wording' | 'quote' | 'transcript' | 'unknown';
export type ClaimTone = 'concern' | 'review' | 'ok' | 'notAssessed';

export interface StoredAnswer {
  findingId: string;
  findingStep: string;
  verdict: string;
  reason: string | null;
  note: string | null;
  coachId: string;
  coachName: string;
  updatedAt: Date;
}

export interface EarlierAnswer extends StoredAnswer {
  auditId: string;
  criteriaVersion: string;
  generatedAt: Date;
}

export interface ShownAnswer {
  verdict: string;
  reason: string | null;
  note: string | null;
  coachName: string;
  updatedAt: Date;
}

export interface CarriedAnswer extends ShownAnswer {
  /** The criteria version of the audit the answer was given on. */
  fromCriteria: string;
  /** True only when the finding is the same claim it was then. */
  stillStands: boolean;
  /** What differs, when it does not stand. */
  changes: ClaimChange[];
  /** What the finding's verdict was when it was answered, if known. */
  was: ClaimTone | null;
}

export interface FindingFeedbackShape {
  mine: ShownAnswer | null;
  others: ShownAnswer[];
  carried: { mine: CarriedAnswer | null; others: CarriedAnswer[] };
}

export const claimTone = (f: Pick<AuditFinding, 'verdict' | 'notAssessed'>): ClaimTone =>
  f.notAssessed ? 'notAssessed' : f.verdict;

const passages = (f: AuditFinding) =>
  f.evidence.map((e) => `${e.line}-${e.lineEnd ?? e.line}`).join(',');

/**
 * What differs between a finding as it was answered and as it is now. Empty
 * means it is the same claim. `then` is undefined when the earlier audit can
 * no longer be read or does not contain the finding: that is "unknown", and
 * unknown is never treated as unchanged.
 */
export function claimChanges(
  then: AuditFinding | undefined,
  now: AuditFinding,
  sameTranscript: boolean,
): ClaimChange[] {
  if (!then) return ['unknown'];
  const out: ClaimChange[] = [];
  if (claimTone(then) !== claimTone(now)) out.push('verdict');
  if (then.name !== now.name) out.push('wording');
  // Line numbers mean nothing across two versions of a transcript, so there
  // the passages are not compared: the transcript changing is the change.
  if (!sameTranscript) out.push('transcript');
  else if (passages(then) !== passages(now)) out.push('quote');
  return out;
}

const shown = (a: StoredAnswer): ShownAnswer => ({
  verdict: a.verdict,
  reason: a.reason,
  note: a.note,
  coachName: a.coachName,
  updatedAt: a.updatedAt,
});

/**
 * Everything to show under one finding: the answers given on this audit, and
 * the ones carried over from earlier audits of the same recording.
 *
 * `current` are the rows stored on this audit (withdrawals included — they
 * are what stops an old answer coming forward). `earlier` are the rows stored
 * on earlier audits of the same recording, in any order. `earlierAudits` maps
 * an earlier audit's id to its result, or null if it can no longer be read.
 */
export function feedbackFor(args: {
  finding: AuditFinding;
  viewerId: string;
  contentSha256: string;
  current: StoredAnswer[];
  earlier: EarlierAnswer[];
  earlierAudits: Map<string, AuditResult | null>;
}): FindingFeedbackShape {
  const { finding, viewerId } = args;
  const step = findingStepKey(finding.step);
  const isThis = (a: StoredAnswer) => a.findingId === finding.id && a.findingStep === step;

  const here = args.current.filter(isThis);
  const answered = here.filter((a) => a.verdict !== FEEDBACK_WITHDRAWN);
  const spokenHere = new Set(here.map((a) => a.coachId));

  // Each reviewer's LATEST earlier word on this finding: newest audit first,
  // and within one audit the most recently changed.
  const latest = new Map<string, EarlierAnswer>();
  const newestFirst = args.earlier
    .filter(isThis)
    .sort(
      (a, b) =>
        b.generatedAt.getTime() - a.generatedAt.getTime() ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  for (const a of newestFirst) if (!latest.has(a.coachId)) latest.set(a.coachId, a);

  const carried: { coachId: string; answer: CarriedAnswer }[] = [];
  for (const [coachId, a] of latest) {
    // Anything said on this audit — an answer or a withdrawal — replaces it.
    if (spokenHere.has(coachId)) continue;
    // Her last word was to take it back: nothing comes forward.
    if (a.verdict === FEEDBACK_WITHDRAWN) continue;
    const audit = args.earlierAudits.get(a.auditId) ?? null;
    const then = audit?.findings.find(
      (f) => f.id === finding.id && findingStepKey(f.step) === step,
    );
    const changes = claimChanges(
      then,
      finding,
      audit !== null && audit.contentSha256 === args.contentSha256,
    );
    carried.push({
      coachId,
      answer: {
        ...shown(a),
        fromCriteria: a.criteriaVersion,
        stillStands: changes.length === 0,
        changes,
        was: then ? claimTone(then) : null,
      },
    });
  }

  return {
    mine: answered.filter((a) => a.coachId === viewerId).map(shown)[0] ?? null,
    others: answered.filter((a) => a.coachId !== viewerId).map(shown),
    carried: {
      mine: carried.find((c) => c.coachId === viewerId)?.answer ?? null,
      others: carried.filter((c) => c.coachId !== viewerId).map((c) => c.answer),
    },
  };
}
