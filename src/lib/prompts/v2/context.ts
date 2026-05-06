import 'server-only';
import { db } from '@/db';
import {
  ceoKpiDefinitions,
  cycleFacts,
  cycleKpiValues,
  cycles,
  journalEntries,
  reports,
  transcripts,
  type Ceo,
  type Cycle,
  type CycleFacts as CycleFactsRow,
} from '@/db/schema';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  inputBelongsToCycle,
  journalEffectiveDate,
  transcriptEffectiveDate,
} from '@/lib/cycles/membership';
import type { CycleFacts as CycleFactsT, Patterns as PatternsT } from './schemas';

/**
 * Shared per-cycle context bundle. Stages A, B, C, D all read from
 * this so we fetch raw inputs once per generation, not once per stage.
 * Mirrors the data buildPrompt v1 pulls — same cycle-membership
 * derivation, same KPI series shape — but returned as structured
 * arrays instead of pre-formatted strings.
 */

export type CycleContext = {
  cycle: Cycle;
  ceo: Ceo;
  coachName: string;
  monthlyGoals: string;
  monthlyReflection: string;
  additionalContext: string;
  journals: Array<{
    title: string;
    weekNumber: number;
    entryDate: string | null;
    content: string;
  }>;
  transcripts: Array<{
    title: string;
    recordedAt: Date | null;
    content: string;
  }>;
  kpiSeries: Array<{
    label: string;
    unit: string | null;
    target: string | null;
    points: Array<{
      cycleLabel: string;
      cycleId: string;
      value: string;
      trend: string | null;
      note: string | null;
      isCurrent: boolean;
    }>;
  }>;
  previousReports: Array<{
    cycleLabel: string;
    rawText: string;
    patternObservations: string | null;
  }>;
  /** Stage A+B output for prior cycles, oldest first. Empty for Cycle 1. */
  priorFacts: Array<{
    cycleId: string;
    cycleLabel: string;
    facts: CycleFactsT | null;
    patterns: PatternsT | null;
  }>;
  isFirstCycle: boolean;
};

export async function fetchCycleContext(args: {
  cycle: Cycle;
  ceo: Ceo;
  coachName: string;
}): Promise<CycleContext> {
  const { cycle, ceo, coachName } = args;

  // Journals — derived membership: include any journal whose effective
  // date sits inside this cycle's window, even if its primary cycleId
  // is a sibling monthly.
  const journalJoined = await db
    .select({ row: journalEntries, parentPeriodStart: cycles.periodStart })
    .from(journalEntries)
    .innerJoin(cycles, eq(journalEntries.cycleId, cycles.id))
    .where(eq(cycles.ceoId, ceo.id))
    .orderBy(asc(journalEntries.weekNumber));

  const journals = journalJoined
    .filter(({ row, parentPeriodStart }) =>
      inputBelongsToCycle(
        {
          primaryCycleId: row.cycleId,
          effectiveDate: journalEffectiveDate({
            entryDate: row.entryDate,
            weekNumber: row.weekNumber,
            parentPeriodStart,
            createdAt: row.createdAt,
          }),
        },
        cycle,
      ),
    )
    .map(({ row }) => ({
      title: row.title,
      weekNumber: row.weekNumber,
      entryDate: row.entryDate,
      content: row.content,
    }));

  const transcriptJoined = await db
    .select({ row: transcripts })
    .from(transcripts)
    .innerJoin(cycles, eq(transcripts.cycleId, cycles.id))
    .where(eq(cycles.ceoId, ceo.id))
    .orderBy(desc(transcripts.recordedAt));

  const cycleTranscripts = transcriptJoined
    .filter(({ row }) =>
      inputBelongsToCycle(
        {
          primaryCycleId: row.cycleId,
          effectiveDate: transcriptEffectiveDate({
            recordedAt: row.recordedAt,
            createdAt: row.createdAt,
          }),
        },
        cycle,
      ),
    )
    .map(({ row }) => ({
      title: row.title,
      recordedAt: row.recordedAt,
      content: row.content,
    }));

  // KPI multi-cycle series.
  const activeDefs = await db
    .select()
    .from(ceoKpiDefinitions)
    .where(
      and(
        eq(ceoKpiDefinitions.ceoId, ceo.id),
        sql`${ceoKpiDefinitions.archivedAt} is null`,
      ),
    )
    .orderBy(asc(ceoKpiDefinitions.sortOrder), asc(ceoKpiDefinitions.createdAt));

  const allKpiValues = activeDefs.length === 0
    ? []
    : await db
        .select({
          definitionId: cycleKpiValues.definitionId,
          value: cycleKpiValues.value,
          trend: cycleKpiValues.trend,
          note: cycleKpiValues.note,
          cycleId: cycleKpiValues.cycleId,
          cycleLabel: cycles.label,
          cyclePeriodEnd: cycles.periodEnd,
          cycleCreatedAt: cycles.createdAt,
        })
        .from(cycleKpiValues)
        .innerJoin(cycles, eq(cycleKpiValues.cycleId, cycles.id))
        .where(
          and(
            eq(cycles.ceoId, ceo.id),
            inArray(
              cycleKpiValues.definitionId,
              activeDefs.map((d) => d.id),
            ),
          ),
        );

  const seriesByDef = new Map<string, typeof allKpiValues>();
  for (const v of allKpiValues) {
    const list = seriesByDef.get(v.definitionId) ?? [];
    list.push(v);
    seriesByDef.set(v.definitionId, list);
  }
  for (const list of seriesByDef.values()) {
    list.sort((a, b) => {
      const ak = a.cyclePeriodEnd ?? a.cycleCreatedAt.toISOString();
      const bk = b.cyclePeriodEnd ?? b.cycleCreatedAt.toISOString();
      return ak < bk ? -1 : 1;
    });
  }

  const kpiSeries = activeDefs
    .map((def) => {
      const series = seriesByDef.get(def.id) ?? [];
      if (series.length === 0) return null;
      return {
        label: def.label,
        unit: def.unit,
        target: def.target,
        points: series.map((p) => ({
          cycleLabel: p.cycleLabel,
          cycleId: p.cycleId,
          value: p.value,
          trend: p.trend,
          note: p.note,
          isCurrent: p.cycleId === cycle.id,
        })),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Prior cycles — strictly before this one.
  const allCycles = await db
    .select()
    .from(cycles)
    .where(eq(cycles.ceoId, ceo.id));

  const isPrior = (c: (typeof allCycles)[number]) => {
    if (c.id === cycle.id) return false;
    if (cycle.periodStart && c.periodEnd) {
      return c.periodEnd < cycle.periodStart;
    }
    return c.createdAt.getTime() < cycle.createdAt.getTime();
  };

  const priorOldestFirst = allCycles
    .filter(isPrior)
    .sort((a, b) => {
      const ak = a.periodEnd ?? a.createdAt.toISOString();
      const bk = b.periodEnd ?? b.createdAt.toISOString();
      return ak < bk ? -1 : 1;
    });

  // Prior reports + their stored patternObservations.
  const previousReports: CycleContext['previousReports'] = [];
  for (const c of priorOldestFirst) {
    const [r] = await db
      .select()
      .from(reports)
      .where(eq(reports.cycleId, c.id))
      .orderBy(desc(reports.generatedAt))
      .limit(1);
    if (!r) continue;
    const json = r.contentJson as
      | { report?: { patternObservations?: string | null } }
      | null;
    previousReports.push({
      cycleLabel: c.label,
      rawText: r.rawText,
      patternObservations: json?.report?.patternObservations ?? null,
    });
  }

  // Prior CycleFacts rows (Stage A+B output) for the pattern matcher.
  const priorFactRows: CycleFactsRow[] = priorOldestFirst.length === 0
    ? []
    : await db
        .select()
        .from(cycleFacts)
        .where(
          inArray(
            cycleFacts.cycleId,
            priorOldestFirst.map((c) => c.id),
          ),
        );
  const factsByCycleId = new Map(priorFactRows.map((r) => [r.cycleId, r]));
  const priorFacts: CycleContext['priorFacts'] = priorOldestFirst.map((c) => {
    const row = factsByCycleId.get(c.id);
    return {
      cycleId: c.id,
      cycleLabel: c.label,
      facts: (row?.factsJson as CycleFactsT | undefined) ?? null,
      patterns: (row?.patternsJson as PatternsT | undefined) ?? null,
    };
  });

  return {
    cycle,
    ceo,
    coachName,
    monthlyGoals: cycle.monthlyGoals?.trim() ?? '',
    monthlyReflection: cycle.monthlyReflection?.trim() ?? '',
    additionalContext: cycle.additionalContext?.trim() ?? '',
    journals,
    transcripts: cycleTranscripts,
    kpiSeries,
    previousReports,
    priorFacts,
    isFirstCycle: previousReports.length === 0 && priorFacts.length === 0,
  };
}

/** Render the raw context as a plain-text bundle for the model.
 *  Used by Stage A and Stage C user prompts. */
export function renderContextForModel(ctx: CycleContext): string {
  const journalText = ctx.journals.length > 0
    ? ctx.journals
        .map(
          (j) =>
            `### ${j.title} (Week ${j.weekNumber}${j.entryDate ? `, ${j.entryDate}` : ''})\n${j.content}`,
        )
        .join('\n\n')
    : '(no journals provided)';

  const transcriptText = ctx.transcripts.length > 0
    ? ctx.transcripts
        .map(
          (t) =>
            `### ${t.title}${t.recordedAt ? ` (${t.recordedAt.toISOString()})` : ''}\n${t.content}`,
        )
        .join('\n\n---\n\n')
    : ctx.cycle.transcriptSkipped
      ? '(transcript skipped for this session)'
      : '(not provided)';

  const kpiText = ctx.kpiSeries.length > 0
    ? ctx.kpiSeries
        .map((s) => {
          const targetLine = s.target ? `\n  target: ${s.target}` : '';
          const points = s.points
            .map(
              (p) =>
                `  - ${p.cycleLabel}: ${p.value}${p.trend ? ` ${p.trend}` : ''}${p.note ? ` — ${p.note}` : ''}${p.isCurrent ? ' ← this cycle' : ''}`,
            )
            .join('\n');
          return `- **${s.label}**${s.unit ? ` (${s.unit})` : ''}:${targetLine}\n${points}`;
        })
        .join('\n')
    : '(no KPIs recorded for this CEO yet)';

  const previousReportsText = ctx.previousReports.length > 0
    ? ctx.previousReports
        .map((r) => `#### ${r.cycleLabel}\n${r.rawText}`)
        .join('\n\n---\n\n')
    : '(none yet — first cycle for this CEO.)';

  const priorPatternsText = ctx.previousReports
    .map((r) => ({ label: r.cycleLabel, text: (r.patternObservations ?? '').trim() }))
    .filter((r) => r.text.length > 0)
    .map((p) => `#### ${p.label}\n${p.text}`)
    .join('\n\n---\n\n') || '(no prior pattern observations recorded yet.)';

  return [
    `## CEO Profile`,
    `- Name: ${ctx.ceo.name}`,
    `- 10x Goal (stored): ${ctx.ceo.tenXGoal?.trim() || '(not set)'}`,
    ``,
    `## Cycle: ${ctx.cycle.label}`,
    ctx.cycle.periodStart ? `Period start: ${ctx.cycle.periodStart}` : null,
    ctx.cycle.periodEnd ? `Period end: ${ctx.cycle.periodEnd}` : null,
    ``,
    `### Monthly Goals & Commitments`,
    ctx.monthlyGoals || '(not provided)',
    ``,
    `### Weekly Journals`,
    journalText,
    ``,
    `### Monthly Reflection`,
    ctx.monthlyReflection || '(not provided)',
    ``,
    `### KPIs / Metric Updates (multi-cycle series, oldest → newest)`,
    kpiText,
    ``,
    `### Zoom Session Transcript`,
    transcriptText,
    ctx.additionalContext
      ? `\n### Additional Context (coach notes, emails, etc.)\n${ctx.additionalContext}\n`
      : '',
    ``,
    `### Previous Coaching Emails (oldest → newest)`,
    previousReportsText,
    ``,
    `### Prior Pattern Observations`,
    priorPatternsText,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Compute which inputs are missing — drives the "be transparent about
 *  what you don't have" warning in stage prompts. */
export function listMissingInputs(ctx: CycleContext): string[] {
  const missing: string[] = [];
  if (!ctx.ceo.tenXGoal?.trim()) missing.push('10x goal');
  if (!ctx.monthlyGoals) missing.push('monthly goals');
  if (ctx.journals.length === 0) missing.push('weekly journals');
  if (!ctx.monthlyReflection) missing.push('monthly reflection');
  if (ctx.transcripts.length === 0 && !ctx.cycle.transcriptSkipped) {
    missing.push('zoom transcript');
  }
  return missing;
}
