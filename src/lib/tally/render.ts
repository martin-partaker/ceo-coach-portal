import type { TallyQuestion, TallySubmission } from './client';
import { answerToString } from './heuristics';

/**
 * Render a Tally submission as flat Q/A plaintext for AI prompts + search.
 * Works for any form, regardless of whether typed projection exists.
 */
export function renderSubmissionAsText(
  questions: TallyQuestion[],
  submission: TallySubmission
): string {
  const titleByQid = new Map<string, string>();
  for (const q of questions) {
    titleByQid.set(q.id, q.title ?? '(untitled)');
  }

  const lines: string[] = [];
  for (const r of submission.responses) {
    const title = titleByQid.get(r.questionId) ?? r.questionId;
    const ans = answerToString(r.answer);
    if (ans == null) continue;
    lines.push(`Q: ${title}`);
    lines.push(`A: ${ans}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}
