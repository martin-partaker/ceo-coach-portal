import { NextResponse } from 'next/server';
import { listForms, getFormQuestions } from '@/lib/tally/client';
import { upsertTallyForm } from '@/lib/tally/registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${expected}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const forms = await listForms();
  const results: Array<{ formId: string; name: string; isNew: boolean }> = [];

  for (const form of forms) {
    try {
      const questions = await getFormQuestions(form.id);
      const { isNew } = await upsertTallyForm({ form, questionsSnapshot: questions });
      results.push({ formId: form.id, name: form.name, isNew });
    } catch (err) {
      results.push({
        formId: form.id,
        name: form.name,
        isNew: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(err instanceof Error ? { error: err.message } : {}),
      } as { formId: string; name: string; isNew: boolean });
    }
  }

  const newCount = results.filter((r) => r.isNew).length;
  return NextResponse.json({
    discovered: forms.length,
    new: newCount,
    forms: results,
  });
}
