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
  zoomUserEmail: text('zoom_user_email'), // their email in the shared Zoom account (for filtering meetings)
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
  label: text('label').notNull(), // e.g. "Apr 10 → May 10"
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  monthlyGoals: text('monthly_goals'),
  weeklyJournal1: text('weekly_journal_1'),
  weeklyJournal2: text('weekly_journal_2'),
  weeklyJournal3: text('weekly_journal_3'),
  weeklyJournal4: text('weekly_journal_4'),
  weeklyJournal5: text('weekly_journal_5'),
  monthlyReflection: text('monthly_reflection'),
  zoomTranscript: text('zoom_transcript'),
  zoomMeetingId: text('zoom_meeting_id'),
  transcriptSkipped: boolean('transcript_skipped').notNull().default(false),
  previousActionItemsReviewed: boolean('previous_action_items_reviewed')
    .notNull()
    .default(false),
  monthlyGoalsAiSuggested: boolean('monthly_goals_ai_suggested').notNull().default(false),
  monthlyReflectionAiSuggested: boolean('monthly_reflection_ai_suggested').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const actionItems = pgTable('action_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => cycles.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(), // 'CEO' | 'Coach' | 'Other'
  item: text('item').notNull(),
  dueAt: date('due_at'),
  status: text('status').notNull().default('open'), // 'open' | 'done' | 'dropped'
  aiSuggested: boolean('ai_suggested').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => cycles.id, { onDelete: 'cascade' }),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
  contentJson: jsonb('content_json').notNull(), // { progress_summary, key_wins, challenges, pattern_observations, next_steps, resources }
  rawText: text('raw_text').notNull(), // formatted for email copy-paste
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
export type NewCeo = typeof ceos.$inferInsert;
export type Cycle = typeof cycles.$inferSelect;
export type NewCycle = typeof cycles.$inferInsert;
export type ActionItem = typeof actionItems.$inferSelect;
export type NewActionItem = typeof actionItems.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type Curriculum = typeof curriculum.$inferSelect;
