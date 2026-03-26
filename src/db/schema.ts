import {
  pgTable,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  integer,
  uuid,
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
  coachId: uuid('coach_id')
    .notNull()
    .references(() => coaches.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email'),
  tenXGoal: text('ten_x_goal'),
  tenXGoalUpdatedAt: timestamp('ten_x_goal_updated_at'),
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
  content: text('content').notNull(),
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
  title: text('title').notNull(),
  contentText: text('content_text').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
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
