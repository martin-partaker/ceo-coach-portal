import 'server-only';
import { db } from '@/db';
import { curriculum } from '@/db/schema';
import type { Cycle, Ceo, Report } from '@/db/schema';

export async function buildPrompt({
  cycle,
  ceo,
  previousReport,
}: {
  cycle: Cycle;
  ceo: Ceo;
  previousReport: Report | null;
}) {
  // Fetch curriculum from DB
  const rows = await db.select().from(curriculum);
  const curriculumText = rows.map((r) => `### ${r.title}\n${r.contentText}`).join('\n\n');

  // Build missing fields warning
  const missing: string[] = [];
  if (!ceo.tenXGoal?.trim()) missing.push('10x goal');
  if (!cycle.monthlyGoals?.trim()) missing.push('monthly goals');
  const hasJournal = [cycle.weeklyJournal1, cycle.weeklyJournal2, cycle.weeklyJournal3, cycle.weeklyJournal4, cycle.weeklyJournal5].some((j) => j?.trim());
  if (!hasJournal) missing.push('weekly journals');
  if (!cycle.monthlyReflection?.trim()) missing.push('monthly reflection');
  if (!cycle.zoomTranscript?.trim() && !cycle.transcriptSkipped) missing.push('zoom transcript');

  const missingWarning = missing.length > 0
    ? `\n\n⚠️ MISSING INPUTS: The following inputs were not provided: ${missing.join(', ')}. Acknowledge this gap in your output and note which sections may be less specific as a result.`
    : '';

  const systemPrompt = `You are a world-class executive coaching analyst working within the ScaleOS / 10x coaching framework developed by Eric Partaker. Your job is to produce a coaching cycle summary report for a coach to review and send to their CEO client.

## Framework Reference
${curriculumText}

## Guardrails
- Stay within the 10x coaching framework. Use Eric Partaker's language: "best self," "commitment," "constraint," "leverage," "champion proof," "say/do gap."
- No diagnostic or therapeutic language.
- No legal, medical, or mental health claims.
- Professional, direct, and reflective tone.
- Be specific and evidence-based — reference actual inputs, not generic advice.
- If inputs are missing, acknowledge it explicitly rather than generating vague filler.
- Every suggestion must be actionable with a clear next step and owner.

## Output Format
Return a JSON object with exactly these 6 keys:
{
  "progress_summary": "2-3 paragraphs summarizing this cycle's progress",
  "key_wins": "bullet points of concrete wins from the cycle",
  "challenges_constraints": "key challenges and the primary constraint",
  "pattern_observations": "patterns across cycles, behavioral trends",
  "suggested_next_steps": "3-5 prioritized, actionable next steps",
  "suggested_resources": "relevant framework concepts or templates"
}

Return ONLY the JSON object, no markdown fences, no extra text.`;

  const journals = [cycle.weeklyJournal1, cycle.weeklyJournal2, cycle.weeklyJournal3, cycle.weeklyJournal4, cycle.weeklyJournal5]
    .map((j, i) => j?.trim() ? `### Week ${i + 1}\n${j}` : null)
    .filter(Boolean)
    .join('\n\n');

  const userPrompt = `## CEO Profile
- Name: ${ceo.name}
- 10x Goal: ${ceo.tenXGoal?.trim() || '(not set)'}

## Cycle: ${cycle.label}

### Monthly Goals & Commitments
${cycle.monthlyGoals?.trim() || '(not provided)'}

### Weekly Journals
${journals || '(no journals provided)'}

### Monthly Reflection
${cycle.monthlyReflection?.trim() || '(not provided)'}

### Zoom Session Transcript
${cycle.zoomTranscript?.trim() || (cycle.transcriptSkipped ? '(transcript skipped for this cycle)' : '(not provided)')}
${previousReport ? `
### Previous Cycle Report Summary
${typeof previousReport.contentJson === 'object' && previousReport.contentJson !== null ? (previousReport.contentJson as Record<string, string>).progress_summary ?? '' : ''}
` : ''}${missingWarning}

Generate the coaching cycle summary report now.`;

  return { systemPrompt, userPrompt, missing };
}
