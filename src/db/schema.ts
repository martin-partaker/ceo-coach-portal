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
  // Quantitative KPI snapshots for the cycle. Spec ("KPI/metric updates")
  // calls these out as a first-class CEO input. Stored as JSONB so the
  // shape stays flexible (label, value, optional trend, optional note);
  // the typed surface lives on `Kpi` below and on the cycles router input.
  kpis: jsonb('kpis').$type<CycleKpi[]>().notNull().default([]),
  transcriptSkipped: boolean('transcript_skipped').notNull().default(false),
  monthlyGoalsAiSuggested: boolean('monthly_goals_ai_suggested').notNull().default(false),
  monthlyReflectionAiSuggested: boolean('monthly_reflection_ai_suggested').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Single KPI row stored in `cycles.kpis`. Trend is optional so a coach
 *  who's just listing a metric without context isn't forced to pick. */
export interface CycleKpi {
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
  note?: string;
}

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
