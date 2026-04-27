import { INGESTION_CONFIG } from '@/lib/ingestion/config';

const TALLY_BASE_URL = 'https://api.tally.so';

export interface TallyForm {
  id: string;
  name: string;
  isClosed: boolean;
  status: string;
  numberOfSubmissions: number;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TallyQuestion {
  id: string;
  type: string;
  title: string;
  isDeleted: boolean;
  formId: string;
  numberOfResponses: number;
  fields?: Array<{ uuid: string; type: string; questionType: string; title: string }>;
}

export interface TallyResponse {
  id: string;
  questionId: string;
  answer: unknown;
  createdAt: string;
}

export interface TallySubmission {
  id: string;
  formId: string;
  respondentId: string;
  isCompleted: boolean;
  submittedAt: string;
  responses: TallyResponse[];
}

interface FormQuestionsResponse {
  hasResponses: boolean;
  questions: TallyQuestion[];
}

interface SubmissionsPage {
  submissions: TallySubmission[];
  questions: TallyQuestion[];
  page: number;
  limit: number;
  hasMore: boolean;
  totalNumberOfSubmissionsPerFilter: { all: number; completed: number; partial: number };
}

async function tallyFetch<T>(pathAndQuery: string): Promise<T> {
  const apiKey = process.env.TALLY_API_KEY;
  if (!apiKey) throw new Error('TALLY_API_KEY is not set');

  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${TALLY_BASE_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 30;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return tallyFetch<T>(pathAndQuery);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tally GET ${pathAndQuery} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function listForms(): Promise<TallyForm[]> {
  const out: TallyForm[] = [];
  let page = 1;
  while (page <= 100) {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(INGESTION_CONFIG.tallyPageSize),
    });
    const data = await tallyFetch<{ items: TallyForm[]; hasMore?: boolean }>(`/forms?${params}`);
    const items = Array.isArray(data.items) ? data.items : [];
    out.push(...items);
    const hasMore =
      typeof data.hasMore === 'boolean' ? data.hasMore : items.length >= INGESTION_CONFIG.tallyPageSize;
    if (!hasMore || items.length === 0) break;
    page++;
  }
  return out;
}

export async function getFormQuestions(formId: string): Promise<TallyQuestion[]> {
  const data = await tallyFetch<FormQuestionsResponse>(`/forms/${formId}/questions`);
  return Array.isArray(data.questions) ? data.questions : [];
}

/**
 * List submissions for a form, newest first, stopping when we hit `sinceSubmissionId` (cursor).
 * If `sinceSubmissionId` is null, returns ALL submissions (used for first run + backfill).
 */
export async function listSubmissionsSince(
  formId: string,
  sinceSubmissionId: string | null
): Promise<{ submissions: TallySubmission[]; questions: TallyQuestion[] }> {
  const collected: TallySubmission[] = [];
  let questionsSchema: TallyQuestion[] = [];
  let page = 1;
  let hitCursor = false;

  while (page <= 1000 && !hitCursor) {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(INGESTION_CONFIG.tallyPageSize),
    });
    const data = await tallyFetch<SubmissionsPage>(`/forms/${formId}/submissions?${params}`);
    if (page === 1 && Array.isArray(data.questions)) questionsSchema = data.questions;

    const items = Array.isArray(data.submissions) ? data.submissions : [];
    for (const sub of items) {
      if (sinceSubmissionId && sub.id === sinceSubmissionId) {
        hitCursor = true;
        break;
      }
      collected.push(sub);
    }

    if (hitCursor) break;
    const hasMore =
      typeof data.hasMore === 'boolean' ? data.hasMore : items.length >= INGESTION_CONFIG.tallyPageSize;
    if (!hasMore || items.length === 0) break;
    page++;
  }

  return { submissions: collected, questions: questionsSchema };
}
