import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gold-standard exemplars used as few-shot input in the Stage C drafter
 * system prompt. Read once at module init (these files don't change at
 * runtime) and embedded in the cached prompt prefix.
 */

const FEWSHOT_DIR = path.join(process.cwd(), 'src', 'lib', 'prompts', 'v2', 'fewshot');

function readSafe(name: string): string {
  try {
    return fs.readFileSync(path.join(FEWSHOT_DIR, name), 'utf8');
  } catch {
    return '';
  }
}

export const GOLD_TIPTON_MILLS = readSafe('gold-tipton-mills.md');
export const GOLD_NONPROFIT = readSafe('gold-nonprofit.md');

/** Bundled few-shot block ready to slot into a system prompt. */
export const FEWSHOT_BLOCK = [
  '## Gold-standard exemplars',
  '',
  'Below are two examples of monthly progress summaries that hit the bar.',
  'Match the **specificity, structure, and tone** — not the exact wording.',
  'Notice in particular: the explicit goal cascade, the named "Flag for',
  'Coach Review" callouts, quantified weekly effort, role-specific',
  'feedback to multiple named stakeholders, every section anchored in',
  'concrete numbers, and counter-factual prescriptions in next steps.',
  '',
  '### Exemplar 1 — Manufacturing CEO (Month 1, includes a goal-drift flag and an emotional event)',
  '',
  GOLD_TIPTON_MILLS.trim(),
  '',
  '### Exemplar 2 — Nonprofit CEO (constraint-led cycle summary)',
  '',
  GOLD_NONPROFIT.trim(),
  '',
].join('\n');
