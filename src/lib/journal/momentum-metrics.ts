/**
 * Momentum Check well-being metrics.
 *
 * The weekly journal (a Tally form) captures four self-reported 1–10
 * scores as plain "Q:/A:" text inside `journal_entries.content`:
 *
 *   Q: Energy level
 *   A: 8
 *   Q: Level of focus
 *   A: 8
 *   Q: Stress level
 *   A: 3
 *   Q: How well did I complete highest leverage work this week?
 *   A: 6
 *
 * There are no structured columns for these — they live in free text — so
 * this module parses them deterministically (no LLM) and aggregates the
 * monthly average per metric with a stoplight colour, per client spec:
 *
 *   Green  8–10   ·  Yellow 5–7  ·  Red 1–4
 *
 * Stress runs on the OPPOSITE scale (a high stress score is bad), so its
 * colour mapping is inverted: high stress → red, low stress → green.
 *
 * Used by the report PDF + on-screen renderer to show this month's
 * averages (and, when available, the prior month's) in the Momentum
 * Check section.
 */

export type MomentumMetricKey = 'energy' | 'focus' | 'stress' | 'leverage';

export type StoplightColor = 'green' | 'yellow' | 'red';

/** Fixed display order + labels for the four metrics. */
export const MOMENTUM_METRICS: Array<{
  key: MomentumMetricKey;
  label: string;
  /** True for stress — high is bad, so the colour scale inverts. */
  inverted: boolean;
}> = [
  { key: 'energy', label: 'Energy level', inverted: false },
  { key: 'focus', label: 'Level of focus', inverted: false },
  { key: 'stress', label: 'Stress level', inverted: true },
  { key: 'leverage', label: 'Highest leverage work', inverted: false },
];

/**
 * Map a journal question to its metric key, or null if the question isn't
 * one of the four tracked scores. Matching is loose (lower-cased
 * substring) so minor wording changes to the Tally form still resolve.
 */
function questionToMetric(question: string): MomentumMetricKey | null {
  const q = question.toLowerCase();
  if (q.includes('energy')) return 'energy';
  if (q.includes('focus')) return 'focus';
  if (q.includes('stress')) return 'stress';
  // "How well did I complete highest leverage work this week?"
  if (q.includes('leverage')) return 'leverage';
  return null;
}

/**
 * Extract the four numeric scores from a single journal entry's content.
 * Returns a partial map — a metric is omitted when its question isn't
 * present or its answer isn't a 1–10 number.
 */
export function parseJournalScores(
  content: string,
): Partial<Record<MomentumMetricKey, number>> {
  const out: Partial<Record<MomentumMetricKey, number>> = {};
  if (!content) return out;
  // Capture each "Q: <question>\nA: <first answer line>" pair. The four
  // metric answers are a single number on their own line; text answers
  // (which we ignore) simply won't parse to a valid score.
  const re = /Q:\s*([^\n]+)\r?\n+A:\s*([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const metric = questionToMetric(m[1].trim());
    if (!metric || metric in out) continue;
    const numMatch = m[2].trim().match(/-?\d+(?:\.\d+)?/);
    if (!numMatch) continue;
    const value = Number(numMatch[0]);
    if (!Number.isFinite(value) || value < 1 || value > 10) continue;
    out[metric] = value;
  }
  return out;
}

/**
 * Bucket a score into a stoplight colour. `inverted` flips the scale for
 * stress (high = red). Thresholds: 8–10 green, 5–7 yellow, 1–4 red — we
 * bucket the (possibly fractional) average with >= 8 green, >= 5 yellow,
 * else red, then invert for stress.
 */
export function scoreColor(avg: number, inverted: boolean): StoplightColor {
  const base: StoplightColor = avg >= 8 ? 'green' : avg >= 5 ? 'yellow' : 'red';
  if (!inverted) return base;
  return base === 'green' ? 'red' : base === 'red' ? 'green' : 'yellow';
}

export type MomentumAverage = {
  key: MomentumMetricKey;
  label: string;
  /** Average across the journals that reported this metric, 1 decimal. */
  avg: number;
  color: StoplightColor;
  /** How many journals contributed to this average. */
  count: number;
};

/**
 * Aggregate a set of journal contents into per-metric averages + colours.
 * Returns null when none of the journals reported any of the four scores
 * (so callers can skip the block entirely).
 */
export function aggregateMomentum(
  journalContents: string[],
): MomentumAverage[] | null {
  const sums: Record<MomentumMetricKey, { total: number; count: number }> = {
    energy: { total: 0, count: 0 },
    focus: { total: 0, count: 0 },
    stress: { total: 0, count: 0 },
    leverage: { total: 0, count: 0 },
  };

  for (const content of journalContents) {
    const scores = parseJournalScores(content);
    for (const { key } of MOMENTUM_METRICS) {
      const v = scores[key];
      if (typeof v === 'number') {
        sums[key].total += v;
        sums[key].count += 1;
      }
    }
  }

  const rows: MomentumAverage[] = [];
  for (const { key, label, inverted } of MOMENTUM_METRICS) {
    const { total, count } = sums[key];
    if (count === 0) continue;
    const avg = Math.round((total / count) * 10) / 10;
    rows.push({ key, label, avg, color: scoreColor(avg, inverted), count });
  }

  return rows.length > 0 ? rows : null;
}
