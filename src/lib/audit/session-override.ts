/**
 * A reviewer's word on which session a recording is, set against the audit
 * that exists for it.
 *
 * The audits are produced offline, so setting the session cannot re-run one
 * on the spot. What the screens can do at once is be truthful about the audit
 * they hold: if it was run as the session the reviewer names, it stands and
 * the session is now confirmed by a person; if it was run as anything else,
 * it was judged against the wrong outline and is void — shown as superseded,
 * never as verdicts — until the next generation replaces it.
 *
 * "The wrong outline" is the test, not "another number". Sessions 4 to 12
 * share one outline, so a Session 5 that a reviewer says is a Session 7 was
 * judged against the right document all along: its audit stands, the number
 * shown becomes hers, and nothing has to be generated for her to go on
 * reviewing it. Only a correction that changes the outline (a Session 2 that
 * is a Session 3, a session that is not one) puts the audit aside.
 */
import { outlineGroup } from './contract';

export interface SessionOverride {
  /** Null: "not a numbered coaching session". */
  sessionNo: number | null;
  note: string | null;
  setByName: string;
  setAt: Date;
}

export type SessionStanding =
  /** Nobody has said; the session is whatever the audit inferred. */
  | 'automatic'
  /** The reviewer named the session the audit was run as, or another one
   *  judged against the same outline: the audit stands. */
  | 'agrees'
  /** The reviewer named another: the audit is void until regenerated. */
  | 'superseded';

export function sessionStanding(
  auditedAs: number | null,
  override: Pick<SessionOverride, 'sessionNo'> | null,
): SessionStanding {
  if (!override) return 'automatic';
  if (override.sessionNo === auditedAs) return 'agrees';
  const was = outlineGroup(auditedAs);
  return was !== null && was === outlineGroup(override.sessionNo) ? 'agrees' : 'superseded';
}

/** "Session 3", or the words for a recording that is not one. */
export function sessionWords(sessionNo: number | null): string {
  return sessionNo === null ? 'Not a numbered session' : `Session ${sessionNo}`;
}
