/**
 * Activate the canonical Tally forms with their content types — equivalent
 * to clicking through the /admin/inbox Forms tab.
 *
 * Run: pnpm activate:forms
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { tallyForms } from '../src/db/schema';

const ACTIVATIONS: Array<{
  formId: string;
  contentType: string;
  projectionEnabled: boolean;
  status?: string;
}> = [
  { formId: '9qdBGY', contentType: 'weekly_journal', projectionEnabled: true },
  { formId: 'QKA12p', contentType: 'monthly_journal', projectionEnabled: true },
  { formId: 'ODAl8a', contentType: 'goal_worksheet', projectionEnabled: true },
  { formId: 'RGzkkp', contentType: 'intake', projectionEnabled: true },
  { formId: 'LZXkpv', contentType: 'self_assessment', projectionEnabled: false },
  { formId: 'RGzdZQ', contentType: 'support_feedback', projectionEnabled: false },
  // Zapier-in-progress worksheets — explicitly ignored for now
  { formId: '44oQZY', contentType: 'unknown', projectionEnabled: false, status: 'ignored' },
  { formId: 'J9JA9o', contentType: 'unknown', projectionEnabled: false, status: 'ignored' },
];

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  for (const a of ACTIVATIONS) {
    const [updated] = await db
      .update(tallyForms)
      .set({
        status: a.status ?? 'active',
        contentType: a.contentType,
        projectionEnabled: a.projectionEnabled,
        updatedAt: new Date(),
      })
      .where(eq(tallyForms.formId, a.formId))
      .returning();

    if (!updated) {
      console.log(`  ⚠ ${a.formId} not in registry — run pnpm backfill:tally first to discover it`);
      continue;
    }
    console.log(
      `  ${updated.status === 'active' ? '✓' : '·'} ${updated.name.padEnd(40)} → ${updated.contentType} (proj=${updated.projectionEnabled})`
    );
  }

  console.log('\n✅ Forms activated. Now run: pnpm backfill:tally --live');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
