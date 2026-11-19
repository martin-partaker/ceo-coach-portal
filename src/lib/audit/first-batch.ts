/**
 * The first batch a reviewer is offered.
 *
 * After every session was read there are about 2,700 findings "to review"
 * across 195 audits. Nobody answers that, and nobody should try: what the
 * first answers are for is finding where the criteria are wrong, and a dozen
 * sessions show that. So the list opens on a dozen, chosen by a rule rather
 * than by hand, so that the choice can be read, argued with and re-run:
 *
 *   recent        the newest recordings first. They are the ones recorded
 *                 after the outlines were written, where a step "not found"
 *                 is a fair thing to say, and they are what coaching looks
 *                 like now.
 *   diversified   every session type, and within one as many coaches as it
 *                 allows; no CEO twice.
 *
 * Only audits that carry both model readings are eligible — the outline's
 * steps and the session as a whole — so every card in the batch shows
 * everything the audit can show.
 *
 * Computed when the list is read, not stored: there is no table to keep in
 * step, and when newer sessions are audited the batch moves with them. A
 * reviewer's answers stay on the audits they were given on, whichever batch
 * those are in.
 */
import { outlineGroup } from './contract';

export interface BatchRow {
  id: string;
  sessionNo: number | null;
  /** As shown on the list: may carry a title after a comma. */
  coach: string | null;
  /** One name, or several joined with " & ". */
  ceo: string | null;
  recordedAt: Date | string | null;
}

/** How many from each outline, and how many of them one coach may have. */
export const FIRST_BATCH_PLAN: { group: 1 | 2 | 3 | 4; perCoach: number; total: number }[] = [
  { group: 1, perCoach: 1, total: 2 },
  { group: 2, perCoach: 1, total: 2 },
  { group: 3, perCoach: 1, total: 2 },
  // One outline for nine sessions, and where most of the recordings are.
  { group: 4, perCoach: 2, total: 6 },
];

/** "Jim Peduto, ScaleOS 10x Coach" and "Jim Peduto" are one coach. */
export const coachKey = (label: string | null | undefined): string =>
  (label ?? '').split(/\s*[,|(]/)[0].trim() || 'Unknown coach';

const when = (v: Date | string | null): number => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/** The ids of the first batch, in the order to show them: by outline, newest first. */
export function firstBatch(rows: BatchRow[]): string[] {
  const picked: string[] = [];
  const ceosTaken = new Set<string>();
  for (const { group, perCoach, total } of FIRST_BATCH_PLAN) {
    const perCoachCount = new Map<string, number>();
    let taken = 0;
    const candidates = rows
      .filter((r) => outlineGroup(r.sessionNo) === group && r.recordedAt)
      // Newest first; the id settles a tie so the batch never depends on the
      // order the database happened to return the rows in.
      .sort((a, b) => when(b.recordedAt) - when(a.recordedAt) || a.id.localeCompare(b.id));
    for (const r of candidates) {
      if (taken >= total) break;
      const coach = coachKey(r.coach);
      const ceos = (r.ceo ?? '').split(' & ').map((n) => n.trim()).filter(Boolean);
      if ((perCoachCount.get(coach) ?? 0) >= perCoach) continue;
      if (ceos.some((n) => ceosTaken.has(n))) continue;
      picked.push(r.id);
      taken += 1;
      perCoachCount.set(coach, (perCoachCount.get(coach) ?? 0) + 1);
      for (const n of ceos) ceosTaken.add(n);
    }
  }
  return picked;
}
