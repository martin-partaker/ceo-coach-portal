import type { TallyQuestion } from './client';

const NAME_TITLE_RX = /^\s*(name|your name|full name|your full name)\b/i;
const CLIENT_NAME_TITLE_RX =
  /^\s*(client'?s?\s*name|name of (your )?client|(your )?ceo'?s?\s*name|coachee'?s?\s*name|name of (your )?coachee)\b/i;
const EMAIL_TITLE_RX = /\bemail\b|e[\s-]?mail/i;

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

  // Email: prefer INPUT_EMAIL, fall back to INPUT_TEXT with "email" in the title.
  let emailQuestion = live.find((q) => q.type === 'INPUT_EMAIL');
  if (!emailQuestion) {
    emailQuestion = live.find(
      (q) => q.type === 'INPUT_TEXT' && EMAIL_TITLE_RX.test(q.title ?? '')
    );
  }

  // Name: prefer "Name"-titled INPUT_TEXT, but DON'T pick the email field
  // when its type is INPUT_TEXT.
  let nameQuestion = live.find(
    (q) =>
      q.type === 'INPUT_TEXT' &&
      NAME_TITLE_RX.test(q.title ?? '') &&
      !EMAIL_TITLE_RX.test(q.title ?? '')
  );
  if (!nameQuestion) {
    nameQuestion = live.find(
      (q) => q.type === 'INPUT_TEXT' && !EMAIL_TITLE_RX.test(q.title ?? '')
    );
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

/**
 * Find a question id whose title looks like "Client's name" / "CEO's name" /
 * "Coachee's name" — used for forms that are filled out BY a coach ABOUT a
 * client (e.g. Self-Assessment).
 */
export function findClientNameQuestionId(questions: TallyQuestion[]): string | null {
  const live = questions.filter((q) => !q.isDeleted);
  for (const q of live) {
    if (q.type !== 'INPUT_TEXT') continue;
    if (CLIENT_NAME_TITLE_RX.test(q.title ?? '')) return q.id;
  }
  return null;
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
