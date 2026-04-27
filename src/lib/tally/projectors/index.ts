import type { Projector } from './types';
import { projectWeeklyJournal } from './weekly-journal';
import { projectMonthlyJournal } from './monthly-journal';
import { projectGoalWorksheet } from './goal-worksheet';
import { projectIntake } from './intake';
import { projectTranscript } from './transcript';

export type { Projector, ProjectionContext } from './types';

/**
 * ContentType → typed projector. Forms not in this map go raw-only — their
 * payload + textContent stay in raw_inputs and feed AI prompts directly,
 * but no typed table is written. Add a projector here when you want
 * structured access (e.g. journal_entries rows for a new survey type).
 */
export const PROJECTORS: Record<string, Projector | undefined> = {
  weekly_journal: projectWeeklyJournal,
  monthly_journal: projectMonthlyJournal,
  goal_worksheet: projectGoalWorksheet,
  intake: projectIntake,
  transcript: projectTranscript,
};
