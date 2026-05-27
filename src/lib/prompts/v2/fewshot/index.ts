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
  'Below are two examples of polished monthly progress summaries that hit the bar.',
  'Match the **specificity, structure, voice, and formatting** — not the exact wording.',
  '',
  'These exemplars are rendered markdown showing what the COMPOSED report looks',
  'like in the platform. Your job is to produce the JSON that, after the renderer',
  'composes it, looks like this. Section titles ("## 2. Momentum Check", etc.) are',
  'added by the renderer, NOT by you — never include them in your JSON string values.',
  '',
  '### Notice in particular',
  '- **Bold lead-in clause** at the start of every bullet in Key Wins, Challenges, and Flight Plan: Next Steps. The lead-in is the scannable point; the detail follows. Coach reads the bolded fragments and follows the story.',
  '- **Goal Summary uses sub-bullets per CEO** for 90-day and 30-day goals when a team has divergent goals. Each goal NAMES the underlying constraint it addresses — not just restate the goal.',
  '- **Momentum Check has a "Minutes dedicated to the 10x goal" table** with one row per member. When a prior month is available, add a column for it; otherwise a single current-month column. 1–2 sentences of interpretive commentary after the table — focus on the daily rhythm pattern, not raw totals.',
  '- **Momentum Check has a Metrics bullet block** separating "what moved" from "what didn\'t move".',
  '- **Flight Patterns is its own section** (between Challenges and Flight Plan), not buried inside Challenges. 3–4 forward-looking threads — what does this pattern mean for next month?',
  '- **Flight Plan: Recommended Next Steps tags every item** with its Altitude Matrix coordinates in italics immediately after the bold lead-in: `*(Eliminate / Leadership)*` or `*(Elevate + Execute / Self)*`. Dimension is one or two of Elevate/Eliminate/Execute; pillar is exactly one of Self/Leadership/Company.',
  '- **Closing block at the bottom** — one encouraging sentence that cites a specific event from this month, followed by **Next session: <date>** in bold on its own line.',
  '- **Coach Review Flag titles are imperative** (verb-first): "Lock the 10x goal…", "Open with a personal check-in…", "Probe Megalabs root cause" — never declarative like "The 10x goal conflicts with…".',
  '- **Flight System vocabulary used naturally** where it fits: Flight Plan, Altitude Matrix, Momentum Loop, lift/drag/thrust, Elevate/Eliminate/Execute, Self/Leadership/Company. Never forced — but when you can say "lift signal" instead of "positive sign" or "primary drag" instead of "main blocker", do.',
  '- **"Month" not "cycle"** in every CEO-facing line. "First month on record", "two months in", "carry into next month".',
  '- **No transcript timestamps** in body text ("~25:00") — reference the session generically ("in session", "in the coaching session").',
  '- **No data-quality caveats** in body text ("inferred from Week 1", "weeks 2–4 missing") — those live in Coach Review Flags only.',
  '- **No relational background on people the CEO already knows** in body text (don\'t describe Michael as "Dave\'s nephew" in Challenges) — that lives in Coach Review Flags only.',
  '- **Past dates use historical tense** ("the estimated close date was ~May 19", not "closing by May 19" when May 19 has passed).',
  '- **Max 5 bullets per section** (up to 7 only for true ties; the win/challenge selection rubric is documented above).',
  '',
  '### Exemplar 1 — Team cycle, Month 2 (paired CEOs, prior-month effort data, goal-drift flag, emotional event, recurring constraint)',
  '',
  GOLD_TIPTON_MILLS.trim(),
  '',
  '### Exemplar 2 — Solo CEO, Month 1 (no prior cycles, single-column effort table, constraint-led baseline)',
  '',
  GOLD_NONPROFIT.trim(),
  '',
].join('\n');
