import 'server-only';
import { db } from '@/db';
import { cycles, reports } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import type { Cycle, Ceo, JournalEntry } from '@/db/schema';

export async function buildPrefillPrompt({
  cycle,
  ceo,
  transcriptText,
  journals,
  additionalContext,
}: {
  cycle: Cycle;
  ceo: Ceo;
  transcriptText: string;
  /** Weekly journal entries within this cycle, ordered as the caller wants
   *  them rendered (typically ascending by week / date). */
  journals?: JournalEntry[];
  additionalContext?: string;
}) {
  // Get previous cycle's context
  const allCycles = await db
    .select()
    .from(cycles)
    .where(eq(cycles.ceoId, ceo.id))
    .orderBy(desc(cycles.createdAt));

  const currentIndex = allCycles.findIndex((c) => c.id === cycle.id);
  const previousCycle = allCycles[currentIndex + 1] ?? null;

  let previousEmail = '';
  let previousGoals = '';

  if (previousCycle) {
    previousGoals = previousCycle.monthlyGoals?.trim() ?? '';

    const [prevReport] = await db
      .select()
      .from(reports)
      .where(eq(reports.cycleId, previousCycle.id))
      .orderBy(desc(reports.generatedAt))
      .limit(1);

    if (prevReport) {
      previousEmail = prevReport.rawText?.substring(0, 2000) ?? '';
    }
  }

  const systemPrompt = `You are an executive coaching assistant. Your job is to analyze a coaching session transcript and extract structured information to help the coach prepare their session notes.

You will extract THREE things:
1. **Monthly Goals & Commitments** — What did the CEO commit to doing? What goals were set or discussed? Pull specific, concrete commitments from the conversation.
2. **Monthly Reflection** — Summarize how the CEO reflected on their progress. What went well? What didn't? What patterns emerged? What did they struggle with?
3. **Action Items** — Concrete, owner-scoped tasks that fell out of the session. Each item must name a single owner ("CEO", "Coach", or "Other"), state the action in one sentence, and include a due date when one was discussed.

## Guidelines
- Be specific — quote or closely paraphrase what the CEO actually said
- Use bullet points for goals/commitments
- Keep the reflection in the CEO's voice where possible
- For action items: pick discrete, verifiable tasks (not vague aspirations). Skip anything you can't tie to a clear owner.
- 0–8 action items is normal. Returning [] is fine if nothing concrete was committed.
- If the transcript is thin on a topic, note what's there but don't fabricate
- These are SUGGESTIONS for the coach to review and edit — mark anything you're uncertain about

## Output Format
Return a JSON object with exactly these keys:
{
  "monthlyGoals": "Extracted goals and commitments as bullet points",
  "monthlyReflection": "Summary of the CEO's self-reflection and progress assessment",
  "actionItems": [
    { "owner": "CEO" | "Coach" | "Other", "item": "Single-sentence action", "dueAt": "YYYY-MM-DD or null" }
  ]
}

Return ONLY the JSON object, no markdown fences, no extra text.`;

  const journalText =
    journals && journals.length > 0
      ? journals
          .map((j) => {
            const header =
              j.title?.trim() ||
              `Week ${j.weekNumber}`;
            const body = j.content?.trim() || '(empty)';
            return `### ${header}\n${body}`;
          })
          .join('\n\n')
      : '';

  const userPrompt = `## CEO Profile
- Name: ${ceo.name}
- 10x Goal: ${ceo.tenXGoal?.trim() || '(not set)'}
${previousGoals ? `
## Previous Session Goals
${previousGoals}
` : ''}${previousEmail ? `
## Previous Coaching Email (for continuity)
${previousEmail}
` : ''}
## Current Session Transcript
${transcriptText || '(no transcript available)'}
${journalText ? `
## Weekly Journals (this cycle)
${journalText}
` : ''}${additionalContext?.trim() ? `
## Additional Context (notes, emails, etc.)
${additionalContext}
` : ''}
Extract the monthly goals and reflection from this session now. Pull from
the transcript AND the weekly journals — journals often contain the CEO's
own framing of progress and commitments that the transcript doesn't surface.`;

  return { systemPrompt, userPrompt };
}
