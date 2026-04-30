/* Shared design tokens + helpers for the Roster v2 surface. The prototype
   uses an OKLCH palette + Geist Mono + a phase color scheme that doesn't
   map cleanly to our shadcn theme — this file centralizes those values so
   the row, timeline, workspace, and Manager view stay consistent. */

import type { RosterPhase } from '@/server/api/routers/roster';

export const PHASE_LABEL: Record<RosterPhase, string> = {
  gathering: 'Gathering',
  ready: 'Ready to gen',
  generated: 'Generated',
  sent: 'Sent',
  idle: 'Idle',
};

export const PHASE_DOT: Record<RosterPhase, string> = {
  gathering: 'var(--muted-foreground)',
  ready: 'oklch(58% 0.13 64)',
  generated: 'oklch(58% 0.14 258)',
  sent: 'oklch(55% 0.12 152)',
  idle: 'var(--border)',
};

export const PHASE_FILL: Record<RosterPhase, string> = {
  gathering: 'transparent',
  ready: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 88%)',
  generated: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 88%)',
  sent: 'color-mix(in oklab, oklch(55% 0.12 152), transparent 92%)',
  idle: 'transparent',
};

export const PHASE_STROKE: Record<RosterPhase, string> = {
  gathering: 'var(--border)',
  ready: 'oklch(58% 0.13 64)',
  generated: 'oklch(58% 0.14 258)',
  sent: 'oklch(55% 0.12 152)',
  idle: 'var(--border)',
};

export const CONTENT_TYPE_DOT: Record<string, string> = {
  weekly_journal: 'oklch(58% 0.14 258)',
  monthly_journal: 'oklch(55% 0.13 280)',
  transcript: 'oklch(58% 0.13 64)',
  intake: 'oklch(55% 0.10 200)',
  ten_x_goal: 'oklch(55% 0.12 152)',
  goal_worksheet: 'oklch(55% 0.12 152)',
  self_assessment: 'oklch(50% 0.06 280)',
  support_feedback: 'oklch(50% 0.06 280)',
  unknown: 'oklch(60% 0.04 260)',
  coach_note: 'oklch(50% 0.06 280)',
  fallback_doc: 'oklch(50% 0.06 280)',
};

export const CONTENT_TYPE_LABEL: Record<string, string> = {
  weekly_journal: 'Weekly',
  monthly_journal: 'Monthly',
  transcript: 'Transcript',
  intake: 'Intake',
  ten_x_goal: '10x',
  goal_worksheet: '10x',
  self_assessment: 'Self-assess',
  support_feedback: 'Feedback',
  unknown: 'Other',
  coach_note: 'Note',
  fallback_doc: 'Doc',
};

export function dayOffset(occurredAt: string, today: Date): number {
  const d = new Date(occurredAt);
  return Math.floor((today.getTime() - d.getTime()) / 86_400_000);
}

export function relativeDay(offset: number): string {
  if (offset === 0) return 'today';
  if (offset === 1) return 'yesterday';
  if (offset < 7) return `${offset}d ago`;
  if (offset < 30) return `${Math.round(offset / 7)}w ago`;
  return `${Math.round(offset / 30)}mo ago`;
}

export function fmtShortDate(s: string): string {
  const [y, m, d] = s.split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${+d}`;
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Tab-friendly cycle label derived from `periodStart` / `periodEnd`.
 *  - Single month:    "Apr 2026"
 *  - Range, same yr:  "Feb–Jun 2026"
 *  - Range, cross-yr: "Dec 2025–Jan 2026"
 *  - No dates set:    falls back to the stored `cycle.label`.
 */
export function deriveCycleLabel(cycle: {
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
}): string {
  if (!cycle.periodStart || !cycle.periodEnd) return cycle.label;
  const [sy, sm] = cycle.periodStart.split('-').map(Number);
  const [ey, em] = cycle.periodEnd.split('-').map(Number);
  if (!sy || !sm || !ey || !em) return cycle.label;
  if (sy === ey && sm === em) return `${MONTHS_SHORT[sm - 1]} ${sy}`;
  if (sy === ey) return `${MONTHS_SHORT[sm - 1]}–${MONTHS_SHORT[em - 1]} ${sy}`;
  return `${MONTHS_SHORT[sm - 1]} ${sy}–${MONTHS_SHORT[em - 1]} ${ey}`;
}
