import 'server-only';
import { db } from '@/db';
import {
  ceoKpiDefinitions,
  ceos as ceosTable,
  coachingTeams,
  cycleFacts,
  cycleKpiValues,
  cycles,
  journalEntries,
  reports,
  transcripts,
  type Ceo,
  type CoachingTeam,
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
  /** The cycle's lead CEO. For solo cycles, the only subject. For
   *  team cycles, the lead member — used as a fallback when downstream
   *  code needs a single name (e.g. legacy callers) but the prompt
   *  itself addresses the full team via `members`. */
  ceo: Ceo;
  /** The team this cycle belongs to, or null for solo cycles. */
  team: CoachingTeam | null;
  /** Every CEO whose inputs feed this cycle's report. For solo, a
   *  single-element list with `ceo`. For team cycles, every member of
   *  the team in stable display order (lead first). */
  members: Ceo[];
  coachName: string;
  /** The shared 10x goal as written. Pulled from the team for team
   *  cycles, from the lead CEO for solo cycles. */
  tenXGoal: string | null;
  /** Concatenated monthlyGoals from this cycle. For team cycles where
   *  parallel cycles exist (one per member), this is the union of
   *  every member's monthly goals for the same period. Solo cycles
   *  just carry their own value. */
  monthlyGoals: string;
  /** Same fan-out treatment as monthlyGoals — when in team mode we
   *  pull every parallel cycle's reflection for the period and
   *  concatenate with author bylines. */
  monthlyReflection: string;
  additionalContext: string;
  /** When team mode pulled scalars from sibling cycles, this captures
   *  per-member contributions so render-time can show "David's monthly
   *  reflection: ..." vs "Dave's monthly reflection: ...". Empty for
   *  solo cycles. */
  perMemberScalars: Array<{
    ceoId: string;
    ceoName: string;
    monthlyGoals: string;
    monthlyReflection: string;
    additionalContext: string;
  }>;
  journals: Array<{
    title: string;
    weekNumber: number;
    entryDate: string | null;
    content: string;
    /** Which team member wrote this. Null for solo cycles or when the
     *  ingestion pipeline couldn't attribute it. */
    authoredBy: { ceoId: string; ceoName: string } | null;
  }>;
  transcripts: Array<{
    title: string;
    recordedAt: Date | null;
    content: string;
    /** Primary speaker / owner. Null when joint (e.g. both members on
     *  the same coaching call). */
    authoredBy: { ceoId: string; ceoName: string } | null;
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

  // ── Resolve the subject: solo CEO OR team ──────────────────────────
  // For team cycles (cycle.teamId set), we fan out and pull inputs from
  // every team member. For solo cycles the "team" is just [ceo].
  let team: CoachingTeam | null = null;
  let members: Ceo[] = [ceo];
  if (cycle.teamId) {
    const [t] = await db
      .select()
      .from(coachingTeams)
      .where(eq(coachingTeams.id, cycle.teamId))
      .limit(1);
    if (t) {
      team = t;
      const allMembers = await db
        .select()
        .from(ceosTable)
        .where(eq(ceosTable.teamId, cycle.teamId))
        .orderBy(asc(ceosTable.createdAt));
      // Put the lead CEO (cycle.ceoId) first for stable display order.
      const lead = allMembers.find((m) => m.id === cycle.ceoId);
      const rest = allMembers.filter((m) => m.id !== cycle.ceoId);
      members = lead ? [lead, ...rest] : allMembers;
    }
  }
  const memberIds = members.map((m) => m.id);
  const ceoNameById = new Map(members.map((m) => [m.id, m.name]));

  // Journals — derived membership: include any journal whose effective
  // date sits inside this cycle's window, even if its primary cycleId
  // is a sibling monthly. For team cycles we query across EVERY
  // member's cycles, not just the lead's.
  const journalJoined = await db
    .select({ row: journalEntries, parentPeriodStart: cycles.periodStart })
    .from(journalEntries)
    .innerJoin(cycles, eq(journalEntries.cycleId, cycles.id))
    .where(inArray(cycles.ceoId, memberIds))
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
    .map(({ row }) => {
      const authorId = row.authoredByCeoId;
      const authorName = authorId ? ceoNameById.get(authorId) ?? null : null;
      return {
        title: row.title,
        weekNumber: row.weekNumber,
        entryDate: row.entryDate,
        content: row.content,
        authoredBy:
          authorId && authorName ? { ceoId: authorId, ceoName: authorName } : null,
      };
    });

  const transcriptJoined = await db
    .select({ row: transcripts })
    .from(transcripts)
    .innerJoin(cycles, eq(transcripts.cycleId, cycles.id))
    .where(inArray(cycles.ceoId, memberIds))
    .orderBy(desc(transcripts.recordedAt));

  // Dedupe transcripts by sourceRawInputId. The same Zoom transcript
  // gets a row per attendee CEO (the ingestion pipeline fans out via
  // raw_input_ceos), which after team formation means the team-aware
  // fetcher would pull the SAME transcript content N times. We keep
  // one row per source and prefer rows that already carry author
  // attribution. Transcripts without a sourceRawInputId (manual paste)
  // are kept as-is — no dedup signal.
  const seenSources = new Set<string>();
  const dedupedTranscriptJoined = transcriptJoined.filter(({ row }) => {
    if (!row.sourceRawInputId) return true;
    if (seenSources.has(row.sourceRawInputId)) return false;
    seenSources.add(row.sourceRawInputId);
    return true;
  });

  const cycleTranscripts = dedupedTranscriptJoined
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
    .map(({ row }) => {
      const authorId = row.authoredByCeoId;
      const authorName = authorId ? ceoNameById.get(authorId) ?? null : null;
      return {
        title: row.title,
        recordedAt: row.recordedAt,
        content: row.content,
        authoredBy:
          authorId && authorName ? { ceoId: authorId, ceoName: authorName } : null,
      };
    });

  // KPI multi-cycle series. For team cycles, prefer team-level
  // definitions (teamId set) and fall back to per-member definitions
  // deduplicated by label so the prompt doesn't see "EBITDA" twice if
  // both David and Dave logged it on their own pre-team rows.
  const kpiDefWhere = team
    ? sql`(${ceoKpiDefinitions.teamId} = ${team.id} OR ${ceoKpiDefinitions.ceoId} IN ${memberIds}) AND ${ceoKpiDefinitions.archivedAt} IS NULL`
    : and(
        eq(ceoKpiDefinitions.ceoId, ceo.id),
        sql`${ceoKpiDefinitions.archivedAt} is null`,
      );
  const allDefsRaw = await db
    .select()
    .from(ceoKpiDefinitions)
    .where(kpiDefWhere)
    .orderBy(asc(ceoKpiDefinitions.sortOrder), asc(ceoKpiDefinitions.createdAt));

  // Dedupe by lower-cased label, preferring team-level defs over
  // per-member duplicates.
  const seenLabels = new Set<string>();
  const activeDefs: typeof allDefsRaw = [];
  for (const def of allDefsRaw) {
    const key = def.label.trim().toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    activeDefs.push(def);
  }

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
            inArray(cycles.ceoId, memberIds),
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

  // Prior cycles — strictly before this one. For team cycles we look
  // across every member's cycle history (covers the pre-team era when
  // each CEO was still solo, plus team cycles since formation).
  const allCycles = await db
    .select()
    .from(cycles)
    .where(inArray(cycles.ceoId, memberIds));

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

  // Resolve the 10x goal: team-level wins when set, falls back to the
  // lead CEO's per-person field for solo cycles or pre-team setups.
  const tenXGoal = (team?.tenXGoal?.trim() || ceo.tenXGoal?.trim() || null) ?? null;

  // Fan-out cycle-scalars across team members. For a team cycle in
  // Apr 2026, each member typically has their OWN Apr 2026 cycle
  // (pre-team backfill leaves parallel cycles in place). Without this
  // fan-out, generating Mar/David's cycle would see only David's
  // monthly reflection — Dave's reflection on his parallel Mar cycle
  // would be invisible to the prompt. We pull every team cycle in
  // the same period and concatenate the scalars with author bylines.
  let perMemberScalars: CycleContext['perMemberScalars'] = [];
  let mergedMonthlyGoals = cycle.monthlyGoals?.trim() ?? '';
  let mergedMonthlyReflection = cycle.monthlyReflection?.trim() ?? '';
  let mergedAdditionalContext = cycle.additionalContext?.trim() ?? '';

  if (team && cycle.periodStart && cycle.periodEnd && members.length > 1) {
    const siblingCycles = await db
      .select({
        id: cycles.id,
        ceoId: cycles.ceoId,
        monthlyGoals: cycles.monthlyGoals,
        monthlyReflection: cycles.monthlyReflection,
        additionalContext: cycles.additionalContext,
      })
      .from(cycles)
      .where(
        and(
          eq(cycles.teamId, team.id),
          eq(cycles.periodStart, cycle.periodStart),
          eq(cycles.periodEnd, cycle.periodEnd),
        ),
      );

    // Order siblings so the lead member comes first, then others by
    // member display order. Stable bylines in the rendered prompt.
    const memberOrder = new Map(members.map((m, i) => [m.id, i]));
    siblingCycles.sort((a, b) => {
      const aIdx = memberOrder.get(a.ceoId) ?? 999;
      const bIdx = memberOrder.get(b.ceoId) ?? 999;
      return aIdx - bIdx;
    });

    perMemberScalars = siblingCycles
      .map((sc) => ({
        ceoId: sc.ceoId,
        ceoName: ceoNameById.get(sc.ceoId) ?? '(unknown)',
        monthlyGoals: sc.monthlyGoals?.trim() ?? '',
        monthlyReflection: sc.monthlyReflection?.trim() ?? '',
        additionalContext: sc.additionalContext?.trim() ?? '',
      }))
      // Skip rows that contribute nothing — keeps the prompt clean.
      .filter(
        (m) =>
          m.monthlyGoals || m.monthlyReflection || m.additionalContext,
      );

    // Concatenate for backwards-compat callers that read the flat
    // string fields. Each contributor's section is bylined so the
    // model can attribute. Empty contributions skipped.
    if (perMemberScalars.length > 0) {
      const concatField = (
        get: (m: (typeof perMemberScalars)[number]) => string,
      ) =>
        perMemberScalars
          .filter((m) => get(m))
          .map((m) => `### ${m.ceoName}\n${get(m)}`)
          .join('\n\n---\n\n');

      const goals = concatField((m) => m.monthlyGoals);
      const reflection = concatField((m) => m.monthlyReflection);
      const extra = concatField((m) => m.additionalContext);
      if (goals) mergedMonthlyGoals = goals;
      if (reflection) mergedMonthlyReflection = reflection;
      if (extra) mergedAdditionalContext = extra;
    }
  }

  return {
    cycle,
    ceo,
    team,
    members,
    coachName,
    tenXGoal,
    monthlyGoals: mergedMonthlyGoals,
    monthlyReflection: mergedMonthlyReflection,
    additionalContext: mergedAdditionalContext,
    perMemberScalars,
    journals,
    transcripts: cycleTranscripts,
    kpiSeries,
    previousReports,
    priorFacts,
    isFirstCycle: previousReports.length === 0 && priorFacts.length === 0,
  };
}

/** Render the raw context as a plain-text bundle for the model.
 *  Used by Stage A and Stage C user prompts. For team cycles every
 *  journal and transcript carries an author byline so the model can
 *  attribute statements correctly. */
export function renderContextForModel(ctx: CycleContext): string {
  const isTeam = ctx.team !== null;
  const byline = (a: { ceoName: string } | null) =>
    isTeam && a ? `${a.ceoName}'s ` : '';
  const transcriptByline = (a: { ceoName: string } | null) =>
    isTeam ? (a ? ` (primary: ${a.ceoName})` : ' (joint — both members)') : '';

  const journalText = ctx.journals.length > 0
    ? ctx.journals
        .map(
          (j) =>
            `### ${byline(j.authoredBy)}${j.title} (Week ${j.weekNumber}${j.entryDate ? `, ${j.entryDate}` : ''})\n${j.content}`,
        )
        .join('\n\n')
    : '(no journals provided)';

  const transcriptText = ctx.transcripts.length > 0
    ? ctx.transcripts
        .map(
          (t) =>
            `### ${t.title}${t.recordedAt ? ` (${t.recordedAt.toISOString()})` : ''}${transcriptByline(t.authoredBy)}\n${t.content}`,
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

  // Header block differs for solo vs team cycles. Team cycles get a
  // dedicated team profile + a list of members so the prompt can
  // address everyone by name and assign role-specific feedback.
  const profileBlock = ctx.team
    ? [
        `## Team Profile`,
        `- Team: ${ctx.team.name}${ctx.team.companyName ? ` (${ctx.team.companyName})` : ''}`,
        `- Members (${ctx.members.length}):`,
        ...ctx.members.map(
          (m) =>
            `  - ${m.name}${m.memberRole ? ` — ${m.memberRole}` : ''}`,
        ),
        `- Shared 10x Goal: ${ctx.tenXGoal || '(not set)'}`,
      ].join('\n')
    : [
        `## CEO Profile`,
        `- Name: ${ctx.ceo.name}`,
        `- 10x Goal (stored): ${ctx.tenXGoal || '(not set)'}`,
      ].join('\n');

  return [
    profileBlock,
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

/**
 * Naming helper used by every prompt that addresses the cycle subject.
 * For solo cycles: subjectHandle = "David" (first name). For team
 * cycles: subjectHandle = "David & Dave" (members joined with &) or
 * "David, Dave & Megan" for 3+. The system prompt uses this to address
 * everyone simultaneously without baking pair-only assumptions in.
 *
 *   subjectHandle    — "David" / "David & Dave" — for direct address
 *   subjectFullLabel — "David Harding" / "David Harding & Dave Snyder · Tipton Mills Foods" — for headers
 *   firstNames       — array of first names, useful for role-specific feedback
 *   isTeam           — convenience flag
 */
export function subjectNaming(ctx: CycleContext): {
  isTeam: boolean;
  firstNames: string[];
  subjectHandle: string;
  subjectFullLabel: string;
  teamLabel: string | null;
} {
  const firstNames = ctx.members.map((m) => m.name.split(' ')[0]);
  const isTeam = ctx.team !== null && ctx.members.length > 1;
  const subjectHandle = isTeam ? joinWithAmpersand(firstNames) : firstNames[0] ?? ctx.ceo.name;
  const fullNames = ctx.members.map((m) => m.name);
  const teamLabel = ctx.team ? ctx.team.name : null;
  const subjectFullLabel = isTeam
    ? `${joinWithAmpersand(fullNames)}${teamLabel ? ` · ${teamLabel}` : ''}`
    : ctx.ceo.name;
  return { isTeam, firstNames, subjectHandle, subjectFullLabel, teamLabel };
}

function joinWithAmpersand(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  // Three+: "David, Dave & Megan" (Oxford-ampersand style).
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** Compute which inputs are missing — drives the "be transparent about
 *  what you don't have" warning in stage prompts. Uses the team 10x
 *  goal when in team mode, falls back to per-CEO. */
export function listMissingInputs(ctx: CycleContext): string[] {
  const missing: string[] = [];
  if (!ctx.tenXGoal?.trim()) missing.push('10x goal');
  if (!ctx.monthlyGoals) missing.push('monthly goals');
  if (ctx.journals.length === 0) missing.push('weekly journals');
  if (!ctx.monthlyReflection) missing.push('monthly reflection');
  if (ctx.transcripts.length === 0 && !ctx.cycle.transcriptSkipped) {
    missing.push('zoom transcript');
  }
  return missing;
}
