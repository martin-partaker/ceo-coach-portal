import { z } from 'zod';

/**
 * v2 pipeline schemas — the contract every stage reads/writes.
 *
 *   Stage A (extract-facts)  → CycleFactsSchema
 *   Stage B (match-patterns) → PatternsSchema
 *   Stage C (draft)          → DraftedReportSchema (same shape v1 returned)
 *   Stage D (critique)       → CritiqueSchema
 *   Stage E (refine-section) → RefinementMessageSchema
 *
 * The fact extractor is the load-bearing change: once typed facts
 * exist, every downstream stage can reference them precisely instead
 * of re-reading raw inputs.
 */

// ── Stage A — typed facts ────────────────────────────────────────────

/** Where a quantitative or factual claim came from. The drafter is
 *  required to cite at least one of these per win/challenge so the
 *  output is grounded, not hallucinated. */
export const SourceRefSchema = z.object({
  kind: z.enum(['journal', 'transcript', 'kpi', 'reflection', 'intake', 'previous_report']),
  /** Free-text locator — week 2, transcript timestamp, KPI label, etc.
   *  Doesn't need to be a stable id; it just needs to be specific enough
   *  for a coach to find the source. */
  locator: z.string().min(1),
  /** Verbatim or near-verbatim excerpt that supports the claim. */
  quote: z.string().min(1),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const GoalCascadeSchema = z.object({
  tenX: z.string().describe('The 10x / 3-year destination as stated this cycle.'),
  ninetyDay: z.string().nullable().describe('The 90-day goal this cycle ladders into; null if not stated.'),
  thirtyDay: z.string().nullable().describe('The 30-day commitment this cycle; null if not stated.'),
  driftDetected: z.object({
    changed: z.boolean(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    when: z.string().nullable(),
    note: z.string().nullable(),
  }),
});

export const EffortPointSchema = z.object({
  weekNumber: z.number().int().nullable(),
  weekLabel: z.string().nullable(),
  minutes: z.number().int().nullable(),
  note: z.string().nullable(),
});

export const StakeholderSchema = z.object({
  name: z.string(),
  role: z.string().nullable(),
  appearsIn: z.array(z.string()).default([]),
});

export const EmotionalEventSchema = z.object({
  date: z.string().nullable(),
  description: z.string(),
  source: SourceRefSchema,
  /** Whether this event materially affected effort/output this cycle. */
  affectedCycle: z.boolean().default(false),
});

export const ConstraintSchema = z.object({
  named: z.string().describe('The single highest-leverage constraint named this cycle.'),
  movedThisCycle: z.boolean(),
  evidence: z.string().describe('What changed (or didn\'t).'),
  source: SourceRefSchema,
});

export const EvidenceClaimSchema = z.object({
  /** A single factual or quantitative claim, e.g. "EBITDA tracking from
   *  $3.5M toward $5M" or "Banking moved from zero relationship to two
   *  finalist banks". */
  claim: z.string().min(1),
  source: SourceRefSchema,
  /** Tag for which downstream section this belongs in. */
  category: z.enum(['win', 'challenge', 'metric', 'commitment', 'observation']),
});

export const CycleFactsSchema = z.object({
  goalCascade: GoalCascadeSchema,
  effort: z.object({
    weekly: z.array(EffortPointSchema).default([]),
    anomalies: z.array(z.string()).default([]),
  }),
  stakeholders: z.array(StakeholderSchema).default([]),
  emotionalEvents: z.array(EmotionalEventSchema).default([]),
  constraint: ConstraintSchema.nullable(),
  evidenceClaims: z.array(EvidenceClaimSchema).default([]),
  /** Open commitments the CEO made this cycle, with owners + deadlines
   *  where stated. Drives `suggestedNextSteps` so the model doesn't
   *  invent commitments. */
  commitments: z
    .array(
      z.object({
        item: z.string(),
        owner: z.string().nullable(),
        deadline: z.string().nullable(),
        source: SourceRefSchema,
      }),
    )
    .default([]),
  /** Coach-only review flags — meta-observations the model wants the
   *  coach to see before sending. Surfaced as a "Flag for Coach Review"
   *  callout in the UI; never shown to the CEO. */
  coachReviewFlags: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        urgency: z.enum(['info', 'attention', 'urgent']).default('attention'),
      }),
    )
    .default([]),
});
export type CycleFacts = z.infer<typeof CycleFactsSchema>;

// ── Stage B — patterns ───────────────────────────────────────────────

export const PatternsSchema = z.object({
  /** Behaviours/strengths that have appeared in 2+ cycles. */
  carryingForward: z
    .array(
      z.object({
        pattern: z.string(),
        firstSeenIn: z.string().nullable(),
        evolution: z.string().nullable(),
      }),
    )
    .default([]),
  /** Patterns that shifted this cycle (got better, got worse, became
   *  more specific). */
  evolving: z
    .array(
      z.object({
        pattern: z.string(),
        change: z.string(),
      }),
    )
    .default([]),
  /** Patterns that resolved — the coach should celebrate the close. */
  resolving: z
    .array(
      z.object({
        pattern: z.string(),
        howResolved: z.string(),
      }),
    )
    .default([]),
  /** New patterns that only appeared this cycle. */
  newThisCycle: z.array(z.string()).default([]),
  /** Whether this is the first cycle for the CEO. If true, the drafter
   *  must say so explicitly rather than fabricate patterns. */
  isFirstCycle: z.boolean(),
});
export type Patterns = z.infer<typeof PatternsSchema>;

// ── Stage C — drafted report (same shape v1 returned) ────────────────

export const DraftedReportSchema = z.object({
  // Email view
  subject_line: z.string(),
  opening: z.string(),
  wins_and_progress: z.string(),
  honest_feedback: z.string(),
  key_insight: z.string(),
  commitments: z.string(),
  going_deeper: z.string(),
  closing: z.string(),

  // Structured PDF view
  report: z.object({
    progressSummary: z.string(),
    goalSummary: z
      .object({
        tenX: z.string(),
        ninetyDay: z.string().nullable(),
        thirtyDay: z.string().nullable(),
        flag: z.string().nullable(),
      })
      .nullable(),
    keyWins: z.array(z.string()),
    challenges: z.array(z.string()),
    patternObservations: z.string(),
    suggestedNextSteps: z.array(z.string()),
    suggestedResourceIds: z.array(z.string()).default([]),
    coachReviewFlags: z
      .array(
        z.object({
          title: z.string(),
          detail: z.string(),
          urgency: z.enum(['info', 'attention', 'urgent']).default('attention'),
        }),
      )
      .default([]),
  }),
});
export type DraftedReport = z.infer<typeof DraftedReportSchema>;

// ── Stage D — rubric critic ──────────────────────────────────────────

/**
 * 9-row rubric extracted from the Tipton Mills gold standard. Each item
 * is a binary check the model has either hit or missed. The critic
 * returns reasons + which sections need a rewrite.
 */
export const RUBRIC_ITEMS = [
  {
    id: 'goalCascade',
    label: 'Goal cascade present',
    requirement:
      'The report shows the 10x → 90-day → 30-day cascade explicitly, with at least one sentence on each.',
  },
  {
    id: 'coachReviewFlag',
    label: 'Coach Review Flag when needed',
    requirement:
      'If facts.goalCascade.driftDetected.changed is true OR an emotional event exists OR a constraint did not move, a coachReviewFlag is emitted.',
  },
  {
    id: 'quantifiedEffort',
    label: 'Effort quantified where possible',
    requirement:
      'If facts.effort.weekly is non-empty, progressSummary or wins_and_progress references a specific weekly minutes/hours figure.',
  },
  {
    id: 'stakeholderFeedback',
    label: 'Per-stakeholder feedback',
    requirement:
      'If facts.stakeholders has 2+ entries, the report addresses them by name where role-specific feedback applies.',
  },
  {
    id: 'constraintNamed',
    label: 'Constraint named in patterns/challenges',
    requirement:
      'If facts.constraint is set, challenges or patternObservations names the constraint and connects it to the cycle.',
  },
  {
    id: 'specificNumbers',
    label: 'Specific numbers across sections',
    requirement:
      'progressSummary, keyWins and suggestedNextSteps each contain at least one specific number, date, name, or proper noun from facts.evidenceClaims — not generic descriptors.',
  },
  {
    id: 'counterFactualNextSteps',
    label: 'Counter-factual next steps',
    requirement:
      'At least one suggestedNextSteps item includes a counter-factual or specific magnitude (e.g. "2 hrs focused > 5 hrs fragmented", "within 30 days", "$X by Y").',
  },
  {
    id: 'emotionalEventsHandled',
    label: 'Emotional events handled with care',
    requirement:
      'If facts.emotionalEvents is non-empty, the report addresses them in challenges or honest_feedback with warmth and without minimising.',
  },
  {
    id: 'crossCycleDelta',
    label: 'Cross-cycle delta when not first cycle',
    requirement:
      'If patterns.isFirstCycle is false, patternObservations explicitly compares to prior cycles (carrying forward / evolving / resolving). If isFirstCycle is true, the report says so explicitly.',
  },
] as const;

export type RubricItemId = (typeof RUBRIC_ITEMS)[number]['id'];

export const RubricItemResultSchema = z.object({
  id: z.enum(RUBRIC_ITEMS.map((r) => r.id) as [string, ...string[]]),
  pass: z.boolean(),
  reason: z.string(),
  /** The section(s) the critic thinks need a rewrite to fix this. */
  fixInSections: z
    .array(
      z.enum([
        'progressSummary',
        'keyWins',
        'challenges',
        'patternObservations',
        'suggestedNextSteps',
        'wins_and_progress',
        'honest_feedback',
        'key_insight',
        'opening',
        'commitments',
      ]),
    )
    .default([]),
});

export const CritiqueSchema = z.object({
  pass: z.boolean(),
  items: z.array(RubricItemResultSchema),
  /** Aggregate set of sections to rewrite (union of fixInSections from
   *  failed items). The Stage C re-runner uses this as its work list. */
  weakSections: z.array(z.string()).default([]),
  /** A single sentence the critic would say to the drafter to fix the
   *  most important thing. Logged + shown to the coach in the UI. */
  topFix: z.string().nullable(),
});
export type Critique = z.infer<typeof CritiqueSchema>;

// ── Stage E — refinement chat ────────────────────────────────────────

export const RefinementMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  sectionSnapshot: z.string().nullable().optional(),
});
export type RefinementMessage = z.infer<typeof RefinementMessageSchema>;

/** Sections that can be refined in the per-section chat. */
export const REFINABLE_SECTIONS = [
  'progressSummary',
  'keyWins',
  'challenges',
  'patternObservations',
  'suggestedNextSteps',
  'opening',
  'wins_and_progress',
  'honest_feedback',
  'key_insight',
  'commitments',
] as const;
export type RefinableSection = (typeof REFINABLE_SECTIONS)[number];
