/**
 * Centralised Claude model IDs. Update one line here to bump every
 * caller — instead of hunting through 5 routers + ingestion helpers.
 *
 * Tiered by cost / latency vs prose quality:
 *
 *  - reportPrimary  → highest-stakes prose. The cycle email + per-section
 *                     regenerations land in front of the CEO; we use the
 *                     most capable model. Low call volume (1–2 per cycle).
 *  - draft          → medium-stakes drafts the coach reviews and edits.
 *                     AI prefill of monthly goals/reflection, action item
 *                     extraction. Strong prose at a fraction of Opus cost.
 *  - classifier     → fast, high-volume classification. Triage suggester
 *                     (per pending raw input) + content-type classifier
 *                     (per ingested submission). Latency matters more
 *                     than depth here.
 *
 * Reasoning for current picks:
 *  - Opus 4.7 for reports — the deliverable goes to the CEO, prose
 *    quality is the product, and we only spend Opus tokens once per
 *    cycle so the cost stays predictable.
 *  - Sonnet 4.6 for drafts — coach edits the output anyway; the marginal
 *    quality gap from Opus rarely shows after their pass.
 *  - Haiku 4.5 for classification — sub-second latency, JSON-only output,
 *    fired once per submission so volume × cost matters.
 */
export const MODELS = {
  reportPrimary: 'claude-opus-4-7',
  draft: 'claude-sonnet-4-6',
  classifier: 'claude-haiku-4-5-20251001',
} as const;

export type ClaudeModelId = (typeof MODELS)[keyof typeof MODELS];
