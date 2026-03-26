import 'server-only';
import { db } from '@/db';
import { curriculum, journalEntries, transcripts } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import type { Cycle, Ceo, Report } from '@/db/schema';

export async function buildPrompt({
  cycle,
  ceo,
  coachName,
  previousReport,
}: {
  cycle: Cycle;
  ceo: Ceo;
  coachName: string;
  previousReport: Report | null;
}) {
  // Fetch curriculum from DB
  const rows = await db.select().from(curriculum);
  const curriculumText = rows.map((r) => `### ${r.title}\n${r.contentText}`).join('\n\n');

  // Fetch journals and transcripts for this cycle
  const journals = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.cycleId, cycle.id))
    .orderBy(asc(journalEntries.weekNumber));

  const cycleTranscripts = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.cycleId, cycle.id));

  // Build missing fields warning
  const missing: string[] = [];
  if (!ceo.tenXGoal?.trim()) missing.push('10x goal');
  if (!cycle.monthlyGoals?.trim()) missing.push('monthly goals');
  if (journals.length === 0) missing.push('weekly journals');
  if (!cycle.monthlyReflection?.trim()) missing.push('monthly reflection');
  if (cycleTranscripts.length === 0 && !cycle.transcriptSkipped) missing.push('zoom transcript');

  const missingWarning = missing.length > 0
    ? `\n\n⚠️ MISSING INPUTS: The following inputs were not provided: ${missing.join(', ')}. Work with what you have — be transparent where you're working from limited information, but don't generate vague filler.`
    : '';

  const ceoFirstName = ceo.name.split(' ')[0];

  const journalText = journals.length > 0
    ? journals.map((j) => `### ${j.title}\n${j.content}`).join('\n\n')
    : '(no journals provided)';

  const transcriptText = cycleTranscripts.length > 0
    ? cycleTranscripts.map((t) => `### ${t.title}\n${t.content}`).join('\n\n---\n\n')
    : cycle.transcriptSkipped
      ? '(transcript skipped for this session)'
      : '(not provided)';

  const systemPrompt = `You are writing a personalised coaching update email on behalf of a coach named ${coachName} to their CEO client named ${ceo.name}. This email is sent after each coaching cycle to make the CEO feel heard, understood, and motivated.

## Your role
You are ghostwriting this email AS the coach. Write in first person ("I noticed...", "What stood out to me..."). The tone should be warm but direct — like a trusted advisor who genuinely cares about this person's success. The CEO should read this and think: "My coach really gets me."

## Framework Reference (use this to inform your language and framing)
${curriculumText}

## Writing guidelines
- Address the CEO by first name (${ceoFirstName}).
- Write as if the coach is speaking directly — warm, specific, no corporate jargon.
- Reference SPECIFIC things the CEO said, did, or committed to. Quote their words when possible.
- Celebrate wins concretely — not "great progress" but "you closed the COO hire in 3 weeks."
- Be honest about gaps — if they avoided something, name it kindly but clearly.
- Use Eric Partaker's language naturally: "best self," "say/do gap," "constraint," "champion proof," "momentum."
- Keep the email scannable: short paragraphs, bold for emphasis, bullet points for action items.
- End with clear next commitments and encouragement.
- No diagnostic or therapeutic language. No legal, medical, or mental health claims.

## Output Format
Return a JSON object with exactly these keys:
{
  "subject_line": "Email subject line — personal and specific, not generic",
  "opening": "1-2 paragraphs — personal greeting + high-level reflection on the cycle. Make them feel seen.",
  "wins_and_progress": "What went well this cycle. Be specific — reference their actual inputs. Use bullet points for clarity.",
  "honest_feedback": "Where they got stuck, avoided, or fell short. Kind but clear. Name the pattern if there is one.",
  "key_insight": "The ONE most important observation or pattern you want them to sit with. 2-3 sentences max.",
  "commitments": "Clear numbered list of what they're committing to before next session. Include owners and deadlines where possible.",
  "closing": "Encouraging sign-off. 1-2 sentences. End with the coach's name: ${coachName}"
}

Return ONLY the JSON object, no markdown fences, no extra text.`;

  const userPrompt = `## CEO Profile
- Name: ${ceo.name}
- 10x Goal: ${ceo.tenXGoal?.trim() || '(not set)'}

## Session: ${cycle.label}

### Monthly Goals & Commitments
${cycle.monthlyGoals?.trim() || '(not provided)'}

### Weekly Journals
${journalText}

### Monthly Reflection
${cycle.monthlyReflection?.trim() || '(not provided)'}

### Zoom Session Transcript
${transcriptText}
${cycle.additionalContext?.trim() ? `
### Additional Context (coach notes, emails, etc.)
${cycle.additionalContext}
` : ''}${previousReport ? `
### Previous Session Email (for continuity)
${previousReport.rawText?.substring(0, 1500) ?? ''}
` : ''}${missingWarning}

Write the coaching update email now.`;

  return { systemPrompt, userPrompt, missing };
}
