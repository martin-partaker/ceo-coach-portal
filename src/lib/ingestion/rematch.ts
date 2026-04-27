import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { rawInputs, rawInputCeos, type RawInput } from '@/db/schema';
import { findCeoByEmail } from './identity';
import { fuzzyMatchCeoForCoach } from './match-ceo';
import { ensureCycleForCeoAndDate } from './match-cycle';
import { projectRawInput } from './project';

interface ZoomPayload {
  participants?: Array<{
    name: string;
    user_email?: string;
    internal_user?: boolean;
  }>;
}

interface ClassificationLite {
  meetingType?: string;
}

/**
 * Re-evaluate every pending_ceo row to see if newly-created CEOs / aliases
 * now resolve them. Run this after any admin action that adds a CEO,
 * adds an alias, or moves rosters around.
 *
 * Scoping by `coachId` is recommended — only Zoom rows from that coach's
 * recordings can possibly match the new CEO, and Tally rows are coach-
 * agnostic at email lookup time.
 */
export async function rematchPendingRows(opts?: {
  coachId?: string;
}): Promise<{ scanned: number; resolved: number }> {
  const pending = await db
    .select()
    .from(rawInputs)
    .where(eq(rawInputs.matchStatus, 'pending_ceo'));

  let resolved = 0;

  for (const r of pending) {
    if (r.source === 'tally') {
      if (await tryResolveTally(r)) resolved++;
    }
    // Zoom rows are intentionally NOT auto-resolved by the rematch sweep —
    // every Zoom transcript requires a human triage step regardless of fuzzy
    // confidence (names from Zoom guests are inherently unreliable).
  }

  return { scanned: pending.length, resolved };
}

async function tryResolveTally(r: RawInput): Promise<boolean> {
  const candidates = r.matchCandidates as { email?: string } | null;
  const email = candidates?.email;
  if (!email) return false;

  const ceo = await findCeoByEmail(email);
  if (!ceo) return false;

  // Email match → auto-resolve cycle (creating monthly default if needed).
  const cycleMatch = await ensureCycleForCeoAndDate({
    ceoId: ceo.id,
    occurredAt: r.occurredAt,
  });

  await db
    .update(rawInputs)
    .set({
      ceoId: ceo.id,
      coachId: ceo.coachId,
      cycleId: cycleMatch.cycleId,
      matchStatus: 'matched',
      matchConfidence: cycleMatch.confident ? 100 : 75,
      matchCandidates: { email, name: r.matchCandidates && typeof r.matchCandidates === 'object' ? (r.matchCandidates as { name?: string }).name ?? null : null },
    })
    .where(eq(rawInputs.id, r.id));

  await projectRawInput(r.id);
  return true;
}

async function tryResolveZoom(r: RawInput): Promise<boolean> {
  if (!r.coachId) return false;

  const payload = (r.payloadJson ?? {}) as ZoomPayload;
  const externals = (payload.participants ?? []).filter(
    (p) => !p.internal_user && p.name?.trim()
  );
  if (externals.length === 0) return false;

  const matches = await Promise.all(
    externals.map(async (p) => ({
      participant: p,
      result: await fuzzyMatchCeoForCoach({
        coachId: r.coachId!,
        candidateName: p.name,
      }),
    }))
  );

  const allMatched =
    matches.length > 0 && matches.every((m) => m.result.bestMatch !== null);
  if (!allMatched) return false;

  const primaryCeoId = matches[0].result.bestMatch!.ceoId;
  const confidence = Math.round(
    Math.min(...matches.map((m) => m.result.bestMatch!.score)) * 100
  );
  const cycleMatch = await ensureCycleForCeoAndDate({
    ceoId: primaryCeoId,
    occurredAt: r.occurredAt,
  });

  await db
    .update(rawInputs)
    .set({
      ceoId: primaryCeoId,
      cycleId: cycleMatch.cycleId,
      matchStatus: 'matched',
      matchConfidence: cycleMatch.confident ? confidence : Math.min(confidence, 75),
      matchCandidates: null,
    })
    .where(eq(rawInputs.id, r.id));

  // Group session: link every matched CEO via the join table
  const classification = (r.classification ?? null) as ClassificationLite | null;
  const isGroup = classification?.meetingType === 'coaching_group';
  if (isGroup) {
    for (const m of matches) {
      const ceoId = m.result.bestMatch!.ceoId;
      await db
        .insert(rawInputCeos)
        .values({ rawInputId: r.id, ceoId })
        .onConflictDoNothing();
    }
  }

  await projectRawInput(r.id);
  return true;
}

void and; // exported helper for future query refinements
