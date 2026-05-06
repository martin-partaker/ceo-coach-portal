// NOTE: intentionally NOT `import 'server-only'` — this module is also
// invoked from the `backfill:ten-x-goals` tsx script (Node, not Next.js)
// where the `server-only` shim throws. The function is server-side
// either way; nothing in `app/` client components imports it.
import type Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '@/lib/anthropic/models';
import { anthropic } from '@/lib/anthropic/client';

const SYSTEM_PROMPT = `You extract a CEO's current "10x goal" from their completed goal worksheet.

Context: This CEO is in an executive coaching program based on Eric Partaker's 10x methodology. The "10x goal" is the single biggest aspirational business outcome they're working toward — typically a financial target (revenue, EBITDA, valuation), team size, market position, or impact metric — on a multi-year horizon.

The worksheet contains several questions: some ask about the PAST or current state of the business, some ask about the NEW (10x) target. Your job is to identify the NEW 10x target — the bold, stretched version of the goal the program is meant to help them achieve. Ignore questions that explicitly ask about prior or pre-program goals; prefer questions framed around "10x", "stretch", "bold", "future", "new" goal.

Output rules:
- Return a SINGLE concise sentence, max 25 words.
- Use the CEO's own numbers and phrasing when present.
- If the CEO lists multiple goals, pick the boldest / largest financial outcome.
- If you cannot confidently identify a 10x goal, return exactly the string: NONE
- Return ONLY the sentence (or NONE). No explanation, no quote marks, no markdown, no preamble.`;

/**
 * Extract a clean 10x goal sentence from raw Tally goal-worksheet
 * responses. Returns null when the model can't confidently identify
 * one — the projector falls back to leaving the prior value untouched
 * in that case rather than clobbering a coach-set goal.
 */
export async function extractTenXGoalFromWorksheet(args: {
  ceoName: string;
  rawText: string;
}): Promise<string | null> {
  const { ceoName, rawText } = args;
  const text = rawText.trim();
  if (!text) return null;

  const userPrompt = `CEO: ${ceoName}\n\nWORKSHEET RESPONSES:\n${text}`;

  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create({
      model: MODELS.draft,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('extractTenXGoalFromWorksheet: LLM call failed', err);
    return null;
  }

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return null;

  const cleaned = textBlock.text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^Goal:\s*/i, '')
    .trim();

  if (!cleaned || cleaned.toUpperCase() === 'NONE') return null;
  // Defensive: refuse to return raw Q&A. If the model echoed back the
  // worksheet (which would defeat the point) we treat it as a failure.
  if (/\bQ:\s/.test(cleaned) && /\bA:\s/.test(cleaned)) return null;

  return cleaned;
}
