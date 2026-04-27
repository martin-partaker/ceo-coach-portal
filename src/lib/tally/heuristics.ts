import type { TallyQuestion } from './client';

const NAME_TITLE_RX = /^\s*(name|your name|full name|your full name)\b/i;

export interface IdentityFields {
  emailQuestionId: string | null;
  nameQuestionId: string | null;
  confidence: number; // 0-1
}

/**
 * Auto-detect which questions hold the submitter's email and name.
 * Works on any Tally form without per-form configuration.
 */
export function inferIdentityFields(questions: TallyQuestion[]): IdentityFields {
  const live = questions.filter((q) => !q.isDeleted);

  const emailQuestion = live.find((q) => q.type === 'INPUT_EMAIL');

  let nameQuestion = live.find(
    (q) => q.type === 'INPUT_TEXT' && NAME_TITLE_RX.test(q.title ?? '')
  );
  if (!nameQuestion) {
    nameQuestion = live.find((q) => q.type === 'INPUT_TEXT');
  }

  let confidence = 0;
  if (emailQuestion) confidence += 0.7;
  if (nameQuestion) confidence += 0.3;

  return {
    emailQuestionId: emailQuestion?.id ?? null,
    nameQuestionId: nameQuestion?.id ?? null,
    confidence,
  };
}

export function findResponseAnswer(
  responses: Array<{ questionId: string; answer: unknown }>,
  questionId: string | null | undefined
): unknown {
  if (!questionId) return undefined;
  return responses.find((r) => r.questionId === questionId)?.answer;
}

export function answerToString(answer: unknown): string | null {
  if (answer == null) return null;
  if (typeof answer === 'string') return answer.trim() || null;
  if (typeof answer === 'number' || typeof answer === 'boolean') return String(answer);
  if (Array.isArray(answer)) {
    const parts = answer.map((x) => answerToString(x)).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof answer === 'object') return JSON.stringify(answer);
  return null;
}
