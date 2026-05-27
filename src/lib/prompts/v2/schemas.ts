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
  /** The underlying constraint or problem the 90-day goal addresses
   *  (e.g. "cash flow is gating all growth", "planning ambiguity is
   *  slowing execution"). Drives the Goal Summary rendering: each
   *  shorter-term goal should NAME the constraint it's solving, not
   *  just restate the goal. Null when the goal is too generic to
   *  attribute or no constraint is clearly named in the inputs. */
  ninetyDayConstraint: z.string().nullable().default(null).describe(
    'The constraint or problem the 90-day goal is addressing. Null if not clearly stated.',
  ),
  /** Same as above for the 30-day commitment. */
  thirtyDayConstraint: z.string().nullable().default(null).describe(
    'The constraint or problem the 30-day commitment is addressing. Null if not clearly stated.',
  ),
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
  /** Background context a coach needs but the CEO already knows
   *  (family/employment/remote status, personal history). Quarantined
   *  here so the drafter can pull it into coachReviewFlags without it
   *  leaking into CEO-facing body text. Null when no background
   *  detail is in the inputs. */
  coachOnlyBackground: z.string().nullable().default(null).describe(
    'Background context the CEO already knows but the coach needs (family ties, remote status, employment history). For coachReviewFlags only — never CEO-facing.',
  ),
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
  /** Date of the next agreed-upon coaching session, when explicitly
   *  named in the transcript or session notes (e.g. "June 10, 2026").
   *  Null when no follow-up date was set. The drafter renders this as
   *  the bold sign-off line after the closing sentence. */
  nextSessionDate: z.string().nullable().default(null).describe(
    'The agreed date for the next coaching session, when stated in the transcript. Free-text (e.g. "June 10, 2026"). Null if not stated.',
  ),
  /** Self-reported extraction confidence warnings. Different from
   *  effort.anomalies (which describe the *data*); these describe
   *  Stage A's own confidence in what it extracted (e.g. "I could
   *  only find weekly minutes for Week 1; Weeks 3 and 4 exist but
   *  their minute counts were not explicitly stated"). Surfaced as
   *  [INFO] coach flags downstream. */
  extractionWarnings: z.array(z.string()).default([]).describe(
    'Stage A self-reported confidence warnings about the extraction itself, NOT about the data.',
  ),
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
  /** Intra-month trends visible within the CURRENT cycle when 3+
   *  weekly journals are present (e.g. effort spiking in Week 1 then
   *  collapsing by Week 3). Populated by Stage B even when
   *  isFirstCycle=true — a single cycle with enough weekly data still
   *  shows a meaningful trend the drafter can speak to. Each entry is
   *  a one-sentence observation grounded in the weekly inputs. */
  intraMonthTrends: z.array(z.string()).default([]).describe(
    'Within-cycle trends across the weekly journals (3+ weeks). Populated when isFirstCycle=true and weekly journals show movement worth flagging.',
  ),
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
    /** Closing send-off rendered at the bottom of the document (after
     *  Recommended Next Steps, before Coach Review Flags). Contains an
     *  encouraging sentence specific to this month's story and, when
     *  the transcript named one, the next agreed coaching-session date.
     *  Nullable for backwards compatibility — pre-v4 reports won't
     *  have one and the renderer skips the block when it's missing. */
    closing: z
      .object({
        /** One encouraging sentence that references a specific event
         *  from this month. Must not be reused across months. */
        sentence: z.string(),
        /** Free-text date (e.g. "June 10, 2026"). Rendered as bold
         *  "Next session: …" on the line below the sentence. Null when
         *  the transcript didn't name a follow-up date. */
        nextSessionDate: z.string().nullable(),
      })
      .nullable()
      .default(null),
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
  {
    id: 'boldLeadIns',
    label: 'Bold lead-in on every bullet',
    requirement:
      'Every bullet in keyWins, challenges, and suggestedNextSteps starts with a bolded lead-in clause (markdown **like this**) ending in a period, followed by detail. Lead-ins should be the scannable point so a coach can read just the bolded parts and follow the story.',
  },
  {
    id: 'bulletCap',
    label: 'Bullet count discipline (max 5; ties OK to 7)',
    requirement:
      'keyWins, challenges, and suggestedNextSteps contain no more than 5 bullets each. Up to 7 is acceptable ONLY when the rejected candidates are truly tied in priority (the tiebreaker rule); cutting below 5 is fine.',
  },
  {
    id: 'flightVocab',
    label: 'Flight System vocabulary used naturally',
    requirement:
      'The report uses at least 2 Flight System terms total across all sections — drawn from Flight Plan, Altitude Matrix, Momentum Loop, lift, drag, thrust, Elevate, Eliminate, Execute, Self, Leadership, Company. Used where it fits, not forced into every sentence.',
  },
  {
    id: 'altitudeCoords',
    label: 'Next Steps tagged with Altitude Matrix coordinates',
    requirement:
      'Every entry in suggestedNextSteps includes an italic Altitude Matrix tag in parentheses (e.g. *(Eliminate / Leadership)* or *(Elevate + Execute / Self)*) placed immediately after the bold lead-in clause. The dimension is one or two of Elevate/Eliminate/Execute; the pillar is exactly one of Self/Leadership/Company.',
  },
  {
    id: 'bodyNoCaveats',
    label: 'No data-quality caveats in CEO-facing text',
    requirement:
      'progressSummary, keyWins, challenges, patternObservations, and suggestedNextSteps contain no references to missing journals, inferred goals, or unavailable inputs (e.g. "inferred from Week 1", "Weeks 2–4 not provided", "monthly goals not supplied"). All data-quality observations must live in coachReviewFlags only.',
  },
  {
    id: 'bodyNoTimestamps',
    label: 'No transcript timestamps in CEO-facing text',
    requirement:
      'No CEO-facing section contains transcript timestamps (e.g. "~25:00", "at 14:32", "transcript ~12:00"). Reference the session generically ("in the coaching session", "in session"). Timestamps may appear in coachReviewFlags but never in body sections.',
  },
  {
    id: 'noKnownStakeholderBackground',
    label: 'No background context on people the CEO already knows',
    requirement:
      'Body sections do not introduce or describe people the CEO already knows (family relationships, employment status, remote-work history, who reports to whom). That background lives in coachReviewFlags only. Body text can use a stakeholder\'s name and role title, but not relational or biographical context.',
  },
  {
    id: 'closingSpecific',
    label: 'Closing sentence references this month, non-repeating',
    requirement:
      'report.closing is present, with a sentence that cites a concrete event/win/decision from this month (a specific name, number, or date that actually happened in the cycle). Generic encouragements ("you\'re doing great", "keep it up") fail this check.',
  },
  {
    id: 'coachFlagTitlesImperative',
    label: 'Coach flag titles are imperative',
    requirement:
      'Every coachReviewFlags[i].title starts with a verb in the imperative mood (e.g. "Lock the 10x goal", "Open with a personal check-in", "Probe root cause"). Declarative titles ("The 10x goal conflicts with the team profile") should be reframed as imperatives.',
  },
  {
    id: 'monthNotCycle',
    label: '"Month" used in CEO-facing text, not "cycle"',
    requirement:
      'CEO-facing sections (progressSummary, keyWins, challenges, patternObservations, suggestedNextSteps, opening, wins_and_progress, honest_feedback, key_insight, commitments, closing.sentence) use the word "month" rather than "cycle". Internal coach-only language ("first cycle on record" → "first month on record") follows the same rule.',
  },
  {
    id: 'pastDateTense',
    label: 'Historical tense for past deadlines',
    requirement:
      'Any date referenced in body sections that is before the report generation date uses historical tense (e.g. "the estimated close date was May 19", not "closing by May 19"). Future or undated commitments may use present/future tense.',
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
        'closing',
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
  'closing',
  'opening',
  'wins_and_progress',
  'honest_feedback',
  'key_insight',
  'commitments',
] as const;
export type RefinableSection = (typeof REFINABLE_SECTIONS)[number];
