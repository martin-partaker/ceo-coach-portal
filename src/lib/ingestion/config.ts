export const INGESTION_CONFIG = {
  // Fuzzy match score (0-1). Above this → auto-attach. Below → pending_ceo with top-3 candidates.
  fuzzyMatchThreshold: 0.9,
  // Minimum transcript duration (minutes) to bother classifying. Below → auto-discard.
  minTranscriptMinutes: 5,
  // How far back the Zoom poller re-checks each run, to catch late uploads.
  zoomOverlapHours: 48,
  // Internal email domains — submissions from these are treated as test/internal.
  internalEmailDomains: ['partaker.com'],
  // Tally polling page size.
  tallyPageSize: 100,
  // Anthropic model used for transcript classification.
  classifierModel: 'claude-haiku-4-5-20251001',
};
