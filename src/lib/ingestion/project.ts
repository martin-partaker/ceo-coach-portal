import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { rawInputs, ceos, cycles } from '@/db/schema';
import type { RawInput } from '@/db/schema';
import { PROJECTORS } from '@/lib/tally/projectors';

/**
 * Project a raw_input into typed tables. Idempotent — designed to be re-run
 * after mapper changes. Skips rows that aren't matched + cycled. For unknown
 * content types or unprojectable rows, no-ops (raw stays in raw_inputs).
 */
export async function projectRawInput(rawInputOrId: RawInput | string): Promise<void> {
  const raw =
    typeof rawInputOrId === 'string'
      ? (await db.select().from(rawInputs).where(eq(rawInputs.id, rawInputOrId)).limit(1))[0]
      : rawInputOrId;

  if (!raw) return;
  if (raw.matchStatus !== 'matched') return;
  if (!raw.ceoId) return;

  const projector = PROJECTORS[raw.contentType];
  if (!projector) return; // raw-only content type — feeds AI via textContent

  const [ceo] = await db.select().from(ceos).where(eq(ceos.id, raw.ceoId)).limit(1);
  if (!ceo) return;

  const cycle = raw.cycleId
    ? (await db.select().from(cycles).where(eq(cycles.id, raw.cycleId)).limit(1))[0] ?? null
    : null;

  try {
    await projector({ rawInput: raw, cycle, ceo });
  } catch (err) {
    console.error('Projection failed', { rawInputId: raw.id, contentType: raw.contentType, err });
    // Raw input remains 'matched' — payload + textContent intact. Caller can retry.
  }
}
