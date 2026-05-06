import {
  pgTable,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  integer,
  uuid,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const coaches = pgTable('coaches', {
  id: uuid('id').primaryKey().defaultRandom(),
  neonAuthUserId: text('neon_auth_user_id').unique(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  zoomUserEmail: text('zoom_user_email'),
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const ceos = pgTable('ceos', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable so a CEO can exist on the roster before being assigned to a
  // coach. Deleting a coach moves their CEOs to unassigned (set null)
  // instead of cascading them out of existence.
  coachId: uuid('coach_id').references(() => coaches.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  tenXGoal: text('ten_x_goal'),
  tenXGoalUpdatedAt: timestamp('ten_x_goal_updated_at'),
  profileJson: jsonb('profile_json'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const cycles = pgTable('cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  ceoId: uuid('ceo_id')
    .notNull()
    .references(() => ceos.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  monthlyGoals: text('monthly_goals'),
  monthlyReflection: text('monthly_reflection'),
  additionalContext: text('additional_context'),
  transcriptSkipped: boolean('transcript_skipped').notNull().default(false),
  monthlyGoalsAiSuggested: boolean('monthly_goals_ai_suggested').notNull().default(false),
  monthlyReflectionAiSuggested: boolean('monthly_reflection_ai_suggested').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});


export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => cycles.id, { onDelete: 'cascade' }),
  weekNumber: integer('week_number').notNull(),
  // Exact day the journal entry refers to. Optional for legacy rows that
  // were created with only a weekNumber; new entries should populate it.
  // The membership / sort logic prefers entryDate when present and falls
  // back to (parentCycle.periodStart + (weekNumber-1)·7d) otherwise.
  entryDate: date('entry_date'),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  sourceRawInputId: uuid('source_raw_input_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const transcripts = pgTable('transcripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => cycles.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  content: text('content').notNull(),
  zoomMeetingId: text('zoom_meeting_id'),
  duration: integer('duration'), // minutes
  recordedAt: timestamp('recorded_at'),
  sourceRawInputId: uuid('source_raw_input_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const actionItems = pgTable('action_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => cycles.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  item: text('item').notNull(),
  dueAt: date('due_at'),
  status: text('status').notNull().default('open'),
  aiSuggested: boolean('ai_suggested').notNull().default(false),
  reviewed: boolean('reviewed').notNull().default(false),
  reviewedAt: timestamp('reviewed_at'),
  reviewedBy: uuid('reviewed_by').references(() => coaches.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => cycles.id, { onDelete: 'cascade' }),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
  contentJson: jsonb('content_json').notNull(),
  rawText: text('raw_text').notNull(),
  modelUsed: text('model_used').notNull(),
  promptVersion: integer('prompt_version').notNull().default(1),
});

export const curriculum = pgTable('curriculum', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** What kind of curriculum row this is. Two kinds today:
   *   - `framework` — coaching philosophy / 10x methodology / question
   *     bank summaries. Always loaded into the AI system prompt as the
   *     coach's voice + pedagogy.
   *   - `class` — granular class-section chunks from the bundled CEO
   *     Accelerator materials. The AI is given titles + summaries and
   *     picks 1–3 to surface as "Suggested Resources" per cycle email.
   */
  kind: text('kind').notNull().default('framework'),
  /** Class number 1–12 for kind='class'; null for kind='framework'. */
  classNumber: integer('class_number'),
  /** Subsection name within a class (e.g. "Olympic Day Planner"). */
  section: text('section'),
  /** URL-safe handle. Uniqueness is enforced in the seeding pipeline,
   *  not the DB — making the column unique requires an interactive
   *  drizzle migration we don't want to gate on in a non-TTY context. */
  slug: text('slug'),
  /** Short blurb the AI can read when picking suggested resources. */
  summary: text('summary'),
  title: text('title').notNull(),
  contentText: text('content_text').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// =====================================================================
// Ingestion layer
// =====================================================================

export const rawInputs = pgTable(
  'raw_inputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ceoId: uuid('ceo_id').references(() => ceos.id, { onDelete: 'cascade' }),
    cycleId: uuid('cycle_id').references(() => cycles.id, { onDelete: 'set null' }),
    coachId: uuid('coach_id').references(() => coaches.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    contentType: text('content_type').notNull(),
    externalId: text('external_id').notNull(),
    occurredAt: timestamp('occurred_at').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    textContent: text('text_content'),
    matchStatus: text('match_status').notNull().default('matched'),
    matchConfidence: integer('match_confidence'),
    matchCandidates: jsonb('match_candidates'),
    classification: jsonb('classification'),
    // Cached AI triage suggestion. Computed once at ingest (or lazily on
    // first triage view) and re-used until invalidated. The triage UI
    // reads these columns directly instead of re-running the LLM on every
    // page load. `suggestedAt` is the freshness gate — null means "needs
    // recompute" and is set whenever a new CEO/alias is added or the row's
    // text content changes.
    suggestedCeoId: uuid('suggested_ceo_id').references(() => ceos.id, {
      onDelete: 'set null',
    }),
    suggestedReason: text('suggested_reason'),
    /** Array of `{ ceoId: string; reason: string }` — up to 2 alternates. */
    suggestedAlternatives: jsonb('suggested_alternatives'),
    suggestedAt: timestamp('suggested_at'),
    ingestedAt: timestamp('ingested_at').notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: uuid('resolved_by').references(() => coaches.id),
  },
  (t) => ({
    uniqExternal: uniqueIndex('raw_inputs_source_extid_idx').on(t.source, t.externalId),
    byStatus: index('raw_inputs_status_idx').on(t.matchStatus),
    byCeoOccurred: index('raw_inputs_ceo_occurred_idx').on(t.ceoId, t.occurredAt),
  })
);

export const ceoEmailAliases = pgTable('ceo_email_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  ceoId: uuid('ceo_id')
    .notNull()
    .references(() => ceos.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const ingestionCursors = pgTable('ingestion_cursors', {
  source: text('source').primaryKey(),
  cursor: text('cursor').notNull(),
  lastRunAt: timestamp('last_run_at').notNull().defaultNow(),
  lastSuccessAt: timestamp('last_success_at'),
  lastError: text('last_error'),
});

export const rawInputCeos = pgTable(
  'raw_input_ceos',
  {
    rawInputId: uuid('raw_input_id')
      .notNull()
      .references(() => rawInputs.id, { onDelete: 'cascade' }),
    ceoId: uuid('ceo_id')
      .notNull()
      .references(() => ceos.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.rawInputId, t.ceoId] }),
  })
);

export const tallyForms = pgTable('tally_forms', {
  formId: text('form_id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('pending_review'),
  contentType: text('content_type').notNull().default('unknown'),
  emailQuestionId: text('email_question_id'),
  nameQuestionId: text('name_question_id'),
  projectionEnabled: boolean('projection_enabled').notNull().default(false),
  questionsSnapshot: jsonb('questions_snapshot'),
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * Per-CEO KPI definitions (label, optional unit + target, kind for the
 * input affordance). Definitions persist across cycles so month-over-
 * month progression for "Revenue", "EBITDA", etc. is queryable as a
 * series. Soft-delete via `archivedAt` so historical reports can still
 * resolve a definition that the coach stopped tracking later.
 */
export const ceoKpiDefinitions = pgTable(
  'ceo_kpi_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ceoId: uuid('ceo_id')
      .notNull()
      .references(() => ceos.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** Optional unit hint, e.g. "$", "%". Currently informational; the
     *  PDF renders it adjacent to the value when set. */
    unit: text('unit'),
    /** Optional aspirational target for the KPI (free-text so it can be
     *  "$10M" or "5 finalist banks"). PDF renders progress when both
     *  current and target parse as the same kind of number. */
    target: text('target'),
    /** Drives input UX + parsing. Defaults to 'text' so the coach can
     *  log anything; numeric kinds enable trend math and progress bars. */
    kind: text('kind').notNull().default('text'),
    /** Manual ordering for the editor. Lower comes first. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** Soft-delete: hide from the editor but keep referenced values
     *  intact so old reports / PDFs still render. */
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    ceoIdx: index('ceo_kpi_definitions_ceo_idx').on(t.ceoId),
  }),
);

/** Per-cycle KPI measurement. One row per (cycle × definition).
 *  Trend is stored as the operator's "sticky" choice (auto-derived
 *  trend lives only on the client). */
export const cycleKpiValues = pgTable(
  'cycle_kpi_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => cycles.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => ceoKpiDefinitions.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    trend: text('trend'),
    note: text('note'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    /** A cycle can only have one measurement per definition. */
    cycleDefinitionUnique: uniqueIndex('cycle_kpi_unique').on(
      t.cycleId,
      t.definitionId,
    ),
  }),
);

// =====================================================================
// Report v2 pipeline (A → B → C → D → E)
// =====================================================================

/**
 * Stage A + B output for a cycle: structured facts extracted from raw
 * inputs (goal cascade, weekly effort, named stakeholders, emotional
 * events, the named constraint, and every quantitative claim with a
 * sourceRef back to its journal/transcript/KPI). Cross-cycle Patterns
 * (carrying-forward, evolving, resolving, new) live alongside facts so
 * one row per cycle is enough.
 *
 * One row per cycle. Recompute is fine — we just upsert. The model and
 * timestamps let us know when to invalidate (e.g. journals changed).
 */
export const cycleFacts = pgTable(
  'cycle_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => cycles.id, { onDelete: 'cascade' }),
    factsJson: jsonb('facts_json').notNull(),
    patternsJson: jsonb('patterns_json'),
    modelUsed: text('model_used').notNull(),
    generatedAt: timestamp('generated_at').notNull().defaultNow(),
  },
  (t) => ({
    uniqCycle: uniqueIndex('cycle_facts_cycle_unique').on(t.cycleId),
  }),
);

/**
 * Stage D output: rubric scores for a generated report. The 9-row
 * rubric extracted from the Tipton Mills gold standard. Each report has
 * 0..n critique rows (one per generation pass — first-pass critique +
 * post-revision critique are both kept for evals).
 */
export const reportCritiques = pgTable(
  'report_critiques',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    pass: boolean('pass').notNull(),
    rubricJson: jsonb('rubric_json').notNull(),
    weakSections: jsonb('weak_sections'),
    modelUsed: text('model_used').notNull(),
    generatedAt: timestamp('generated_at').notNull().defaultNow(),
  },
  (t) => ({
    byReport: index('report_critiques_report_idx').on(t.reportId),
  }),
);

/**
 * Stage E: pinned paragraphs the coach wants preserved across
 * regenerations. Identified by `paragraphHash` (stable hash of the
 * paragraph text) so a regeneration can detect "is this still here?"
 * and skip overwriting it. The text is also stored so we can re-insert
 * it if a model regenerates the section without including it.
 */
export const reportPins = pgTable(
  'report_pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    paragraphHash: text('paragraph_hash').notNull(),
    paragraphText: text('paragraph_text').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('report_pins_unique').on(
      t.reportId,
      t.section,
      t.paragraphHash,
    ),
  }),
);

/**
 * Generation job tracking — one row per `generateV2` invocation. The
 * orchestrator updates `status` + `stageDetail` as it transitions
 * through A→B→C→D so the UI can render a live pipeline progress bar
 * and a global "background pill" toast when the modal is closed.
 *
 * The mutation that creates this row also kicks off the pipeline; it
 * does NOT await completion. The client polls `getActiveJob({ cycleId })`
 * every ~1.5s while status != 'complete' / 'error'.
 *
 * `firstDraftJson` is the stage-C output BEFORE any rubric-driven
 * revisions — kept so the UI can render a first→revised section diff.
 */
export const reportGenerationJobs = pgTable(
  'report_generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => cycles.id, { onDelete: 'cascade' }),
    /** 'pending' | 'extracting_facts' | 'matching_patterns'
     *  | 'drafting_first' | 'critiquing' | 'revising' | 'finalising'
     *  | 'complete' | 'error' */
    status: text('status').notNull().default('pending'),
    /** Free-form per-stage detail — e.g. { revision: 1, weakSections: [...] }
     *  or { error: '...' }. Drives the labels under the progress bar. */
    stageDetail: jsonb('stage_detail'),
    /** Stage C output BEFORE the first revision. Null until Stage C completes. */
    firstDraftJson: jsonb('first_draft_json'),
    /** Set once status hits 'complete' — points at the persisted reports row. */
    finalReportId: uuid('final_report_id').references(() => reports.id, {
      onDelete: 'set null',
    }),
    critiqueId: uuid('critique_id').references(() => reportCritiques.id, {
      onDelete: 'set null',
    }),
    revisionsApplied: integer('revisions_applied').notNull().default(0),
    error: text('error'),
    /** Vercel Workflow run id. Set when the pipeline is launched via
     *  `start(generateReportWorkflow, ...)`. Lets cancelGeneration call
     *  `getRun(runId).cancel()` so the workflow runtime stops scheduling
     *  further steps, not just flipping the DB row. */
    workflowRunId: text('workflow_run_id'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => ({
    byCycleStarted: index('report_generation_jobs_cycle_started_idx').on(
      t.cycleId,
      t.startedAt,
    ),
    byStatus: index('report_generation_jobs_status_idx').on(t.status),
  }),
);

/**
 * Stage E: per-section refinement chat. Each row is one turn (coach
 * message OR model response). The chat is scoped to a (report, section)
 * pair so the coach can iterate independently on each section without
 * one conversation polluting another.
 */
export const reportRefinements = pgTable(
  'report_refinements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    role: text('role').notNull(), // 'user' | 'assistant'
    content: text('content').notNull(),
    /** Snapshot of the section's value AFTER this turn (for assistant
     *  turns) — lets the coach diff turns and revert. Null for user
     *  turns. */
    sectionSnapshot: text('section_snapshot'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    byReportSection: index('report_refinements_report_section_idx').on(
      t.reportId,
      t.section,
    ),
  }),
);

// Type exports
export type Coach = typeof coaches.$inferSelect;
export type NewCoach = typeof coaches.$inferInsert;
export type Ceo = typeof ceos.$inferSelect;
export type Cycle = typeof cycles.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type Transcript = typeof transcripts.$inferSelect;
export type ActionItem = typeof actionItems.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Curriculum = typeof curriculum.$inferSelect;
export type RawInput = typeof rawInputs.$inferSelect;
export type NewRawInput = typeof rawInputs.$inferInsert;
export type CeoEmailAlias = typeof ceoEmailAliases.$inferSelect;
export type IngestionCursor = typeof ingestionCursors.$inferSelect;
export type TallyForm = typeof tallyForms.$inferSelect;
export type CeoKpiDefinition = typeof ceoKpiDefinitions.$inferSelect;
export type CycleKpiValue = typeof cycleKpiValues.$inferSelect;
export type KpiKind = 'number' | 'currency' | 'percent' | 'count' | 'text';
export type CycleFacts = typeof cycleFacts.$inferSelect;
export type ReportCritique = typeof reportCritiques.$inferSelect;
export type ReportPin = typeof reportPins.$inferSelect;
export type ReportRefinement = typeof reportRefinements.$inferSelect;
export type ReportGenerationJob = typeof reportGenerationJobs.$inferSelect;
export type ReportGenerationJobStatus =
  | 'pending'
  | 'extracting_facts'
  | 'matching_patterns'
  | 'drafting_first'
  | 'critiquing'
  | 'revising'
  | 'finalising'
  | 'complete'
  | 'error';
