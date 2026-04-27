import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { tallyForms } from '@/db/schema';
import type { TallyForm } from './client';

/**
 * Upsert a discovered Tally form into the registry.
 * - If new: inserts as 'pending_review' with the questions snapshot.
 * - If existing: updates name + questionsSnapshot but preserves status, contentType, projectionEnabled.
 */
export async function upsertTallyForm(args: {
  form: TallyForm;
  questionsSnapshot: unknown;
}) {
  const existing = await db
    .select()
    .from(tallyForms)
    .where(eq(tallyForms.formId, args.form.id))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(tallyForms).values({
      formId: args.form.id,
      name: args.form.name ?? args.form.id,
      status: 'pending_review',
      contentType: 'unknown',
      projectionEnabled: false,
      questionsSnapshot: args.questionsSnapshot as object,
      updatedAt: new Date(),
    });
    return { isNew: true };
  }

  await db
    .update(tallyForms)
    .set({
      name: args.form.name ?? args.form.id,
      questionsSnapshot: args.questionsSnapshot as object,
      updatedAt: new Date(),
    })
    .where(eq(tallyForms.formId, args.form.id));
  return { isNew: false };
}

export async function getActiveTallyForms() {
  return db.select().from(tallyForms).where(eq(tallyForms.status, 'active'));
}

export async function getTallyForm(formId: string) {
  const [row] = await db.select().from(tallyForms).where(eq(tallyForms.formId, formId)).limit(1);
  return row ?? null;
}
