import 'server-only';
import { db } from '@/db';
import { cycles, reports } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import type { Cycle, Ceo } from '@/db/schema';

export async function buildPrefillPrompt({
  cycle,
  ceo,
  transcriptText,
}: {
  cycle: Cycle;
  ceo: Ceo;
  transcriptText: string;
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

You will extract TWO things:
1. **Monthly Goals & Commitments** — What did the CEO commit to doing? What goals were set or discussed? Pull specific, concrete commitments from the conversation.
2. **Monthly Reflection** — Summarize how the CEO reflected on their progress. What went well? What didn't? What patterns emerged? What did they struggle with?

## Guidelines
- Be specific — quote or closely paraphrase what the CEO actually said
- Use bullet points for goals/commitments
- Keep the reflection in the CEO's voice where possible
- If the transcript is thin on a topic, note what's there but don't fabricate
- These are SUGGESTIONS for the coach to review and edit — mark anything you're uncertain about

## Output Format
Return a JSON object with exactly these keys:
{
  "monthlyGoals": "Extracted goals and commitments as bullet points",
  "monthlyReflection": "Summary of the CEO's self-reflection and progress assessment"
}

Return ONLY the JSON object, no markdown fences, no extra text.`;

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

Extract the monthly goals and reflection from this session now.`;

  return { systemPrompt, userPrompt };
}
