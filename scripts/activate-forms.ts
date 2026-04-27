/**
 * Apply default activations to Tally forms — but ONLY for forms still in
 * 'pending_review'. Forms the operator has already activated, ignored, or
 * deactivated are left alone, so the portal is the source of truth for
 * which forms feed ingestion.
 *
 * Defaults:
 *   weekly_journal  → active (projection on)
 *   monthly_journal → active (projection on)
 *   goal_worksheet  → active (projection on)
 *   intake          → active (projection on)
 *   self_assessment → IGNORED (coaches reflecting on themselves; not CEO data)
 *   support_feedback→ IGNORED (admin support, not coaching content)
 *   80/20, Business Model worksheets → IGNORED (Zapier-in-progress)
 *
 * Run: pnpm activate:forms
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { tallyForms } from '../src/db/schema';

interface Default {
  formId: string;
  contentType: string;
  projectionEnabled: boolean;
  defaultStatus: 'active' | 'ignored';
}

const DEFAULTS: Default[] = [
  { formId: '9qdBGY', contentType: 'weekly_journal', projectionEnabled: true, defaultStatus: 'active' },
  { formId: 'QKA12p', contentType: 'monthly_journal', projectionEnabled: true, defaultStatus: 'active' },
  { formId: 'ODAl8a', contentType: 'goal_worksheet', projectionEnabled: true, defaultStatus: 'active' },
  { formId: 'RGzkkp', contentType: 'intake', projectionEnabled: true, defaultStatus: 'active' },
  // Self-assessment is coaches reflecting on themselves — not relevant for
  // CEO monthly summaries. Default to ignored.
  { formId: 'LZXkpv', contentType: 'self_assessment', projectionEnabled: false, defaultStatus: 'ignored' },
  { formId: 'RGzdZQ', contentType: 'support_feedback', projectionEnabled: false, defaultStatus: 'ignored' },
  { formId: '44oQZY', contentType: 'unknown', projectionEnabled: false, defaultStatus: 'ignored' },
  { formId: 'J9JA9o', contentType: 'unknown', projectionEnabled: false, defaultStatus: 'ignored' },
];

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  let touched = 0;
  let preserved = 0;

  for (const d of DEFAULTS) {
    const [existing] = await db
      .select()
      .from(tallyForms)
      .where(eq(tallyForms.formId, d.formId))
      .limit(1);

    if (!existing) {
      console.log(`  ⚠ ${d.formId} not in registry — run pnpm backfill:tally first to discover it`);
      continue;
    }

    // Only touch forms still in 'pending_review' — preserve operator choices.
    if (existing.status !== 'pending_review') {
      console.log(
        `  ↷ ${existing.name.padEnd(40)} status=${existing.status} (preserved)`
      );
      preserved++;
      continue;
    }

    const [updated] = await db
      .update(tallyForms)
      .set({
        status: d.defaultStatus,
        contentType: d.contentType,
        projectionEnabled: d.projectionEnabled,
        updatedAt: new Date(),
      })
      .where(eq(tallyForms.formId, d.formId))
      .returning();
    touched++;

    console.log(
      `  ${updated.status === 'active' ? '✓' : '·'} ${updated.name.padEnd(40)} → ${updated.contentType} (${updated.status}, proj=${updated.projectionEnabled})`
    );
  }

  console.log(
    `\n✅ Defaults applied — ${touched} updated, ${preserved} preserved (operator choices kept).`
  );
  console.log('Tweak in /admin/inbox Forms tab. Then run: pnpm backfill:tally --live');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
