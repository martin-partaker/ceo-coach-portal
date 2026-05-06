/**
 * Centralised Claude model IDs. Update one line here to bump every
 * caller — instead of hunting through 5 routers + ingestion helpers.
 *
 * Tiered by cost / latency vs prose-and-judgment quality:
 *
 *  - reportPrimary  → highest stakes. The CEO-facing email + the v2
 *                     pipeline's load-bearing fact extraction (Stage A)
 *                     and per-section regenerations. Low volume,
 *                     anchors the rest of the pipeline.
 *  - draft          → medium-stakes prose AND structured judgment that
 *                     a critic-grade Haiku would miscalibrate. Critique
 *                     gating, cross-cycle pattern matching, AI prefill
 *                     of monthly goals/reflection, action-item extraction.
 *  - classifier     → fast, high-volume classification. Triage suggester
 *                     (per pending raw input) + content-type classifier
 *                     (per ingested submission). Latency matters more
 *                     than depth here.
 *
 * Reasoning for current picks:
 *  - Opus 4.7 for reports + Stage A — the deliverable goes to the CEO,
 *    prose quality is the product, and Stage A is consumed by every
 *    downstream stage so an extraction miss compounds. Per-cycle volume
 *    keeps the absolute spend predictable.
 *  - Sonnet 4.6 for drafts + Stage D critic — calibrated judgment without
 *    Opus latency. The critic decides when to spend more Opus tokens on
 *    revisions, so its accuracy compounds the Stage C cost picture.
 *  - Haiku 4.5 for classification — sub-second latency, JSON-only output,
 *    fired once per submission so volume × cost matters.
 */
export const MODELS = {
  reportPrimary: 'claude-opus-4-7',
  draft: 'claude-sonnet-4-6',
  classifier: 'claude-haiku-4-5-20251001',
} as const;

export type ClaudeModelId = (typeof MODELS)[keyof typeof MODELS];

/**
 * Per-model documented max output tokens (Anthropic docs, 2026-02-27).
 *
 * `max_tokens` is a required API parameter, but it's a CEILING — not a
 * target. The model stops naturally when its response is complete; a
 * tight cap doesn't save tokens, doesn't enforce brevity, and doesn't
 * reduce latency. It only creates truncation risk. So we set every
 * stage to the model's documented maximum and rely on `assertNotTruncated`
 * as a sanity guard for catastrophic edge cases.
 */
export const MAX_OUTPUT_TOKENS: Record<ClaudeModelId, number> = {
  'claude-opus-4-7': 128_000,
  'claude-sonnet-4-6': 64_000,
  'claude-haiku-4-5-20251001': 64_000,
};
