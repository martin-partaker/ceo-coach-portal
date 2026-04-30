import 'server-only';
import { db } from '@/db';
import {
  ceoKpiDefinitions,
  curriculum,
  cycleKpiValues,
  cycles,
  journalEntries,
  transcripts,
} from '@/db/schema';
import { and, eq, asc, desc, inArray, sql } from 'drizzle-orm';
import type { Cycle, Ceo } from '@/db/schema';
import {
  inputBelongsToCycle,
  journalEffectiveDate,
  transcriptEffectiveDate,
} from '@/lib/cycles/membership';

export async function buildPrompt({
  cycle,
  ceo,
  coachName,
  previousReports,
}: {
  cycle: Cycle;
  ceo: Ceo;
  coachName: string;
  /** Each prior report contributes its raw email body (for continuity)
   *  and — when present — the structured patternObservations field so
   *  the model can write *cross-cycle* patterns rather than reinventing
   *  them from this month's data alone. */
  previousReports: Array<{
    cycleLabel: string;
    rawText: string;
    patternObservations?: string | null;
  }>;
}) {
  // Fetch curriculum from DB. Two layers:
  //   - `framework` rows go into the system prompt as the coach's
  //     pedagogy + voice (~9 rows). The full body is included.
  //   - `class` rows (~91) are a *catalog* the model can choose 1–3
  //     "Suggested Resources" from. We only ship id + title + summary
  //     to keep the prompt cheap; the body lives in the DB and is
  //     surfaced in the UI when the operator clicks through.
  const rows = await db
    .select({
      id: curriculum.id,
      title: curriculum.title,
      contentText: curriculum.contentText,
      summary: curriculum.summary,
      kind: curriculum.kind,
      classNumber: curriculum.classNumber,
      section: curriculum.section,
      sortOrder: curriculum.sortOrder,
    })
    .from(curriculum)
    .orderBy(asc(curriculum.sortOrder));
  const frameworkRows = rows.filter((r) => r.kind === 'framework');
  const classRows = rows.filter((r) => r.kind === 'class');
  const curriculumText = frameworkRows
    .map((r) => `### ${r.title}\n${r.contentText}`)
    .join('\n\n');
  const resourceCatalog = classRows
    .map((r) => `- id: ${r.id}\n  title: ${r.title}\n  summary: ${r.summary ?? ''}`)
    .join('\n');

  // Fetch journals and transcripts for this CEO joined with their parent
  // cycle so we can apply derived (date-range) membership: any input
  // whose primary cycle is this one OR whose effective date sits inside
  // this cycle's [periodStart, periodEnd] window counts as "in" this
  // cycle. This means a stretched cycle (e.g. Feb–Jun) naturally pulls
  // in journals/transcripts that primarily live on monthly sub-cycles.
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
      )
    )
    .map(({ row }) => row);

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
      )
    )
    .map(({ row }) => row);

  // Build missing fields warning
  const missing: string[] = [];
  if (!ceo.tenXGoal?.trim()) missing.push('10x goal');
  if (!cycle.monthlyGoals?.trim()) missing.push('monthly goals');
  if (journals.length === 0) missing.push('weekly journals');
  if (!cycle.monthlyReflection?.trim()) missing.push('monthly reflection');
  if (cycleTranscripts.length === 0 && !cycle.transcriptSkipped) missing.push('zoom transcript');

  const missingWarning = missing.length > 0
    ? `\n\n⚠️ MISSING INPUTS: The following inputs were not provided: ${missing.join(', ')}. Work with what you have — be transparent where you're working from limited information, but don't generate vague filler.`
    : '';

  const ceoFirstName = ceo.name.split(' ')[0];

  const journalText = journals.length > 0
    ? journals.map((j) => `### ${j.title}\n${j.content}`).join('\n\n')
    : '(no journals provided)';

  const transcriptText = cycleTranscripts.length > 0
    ? cycleTranscripts.map((t) => `### ${t.title}\n${t.content}`).join('\n\n---\n\n')
    : cycle.transcriptSkipped
      ? '(transcript skipped for this session)'
      : '(not provided)';

  const previousReportsText = previousReports.length > 0
    ? previousReports
        .map((r) => `#### ${r.cycleLabel}\n${r.rawText}`)
        .join('\n\n---\n\n')
    : '(none yet — this is the first coaching email generated for this CEO. As more cycles are completed, every previously generated coaching email will appear here so you can build on prior themes, language, and commitments.)';

  // Prior cycles' structured `patternObservations`, surfaced as their
  // own block so the model can deliberately compare/contrast across
  // months instead of fishing for them inside long email bodies.
  const priorPatterns = previousReports
    .map((r) => ({ label: r.cycleLabel, text: (r.patternObservations ?? '').trim() }))
    .filter((r) => r.text.length > 0);
  const priorPatternsText = priorPatterns.length > 0
    ? priorPatterns.map((p) => `#### ${p.label}\n${p.text}`).join('\n\n---\n\n')
    : '(no prior pattern observations recorded yet — base patternObservations on this cycle alone, and say so explicitly.)';

  // KPIs (normalized): definitions persist at the CEO level; this
  // cycle's measurements live as cycle_kpi_values rows. We pull the
  // full series for every active definition so the prompt can render
  // each KPI as a multi-month progression — that's the trajectory the
  // model needs to write "EBITDA tracking from $3.5M toward $5M" style
  // analysis instead of a flat single-cell snapshot.
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

  // Group + sort series oldest → newest. Mark which entry corresponds
  // to this cycle so the prompt can highlight the "current" reading.
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

  const kpiBlocks = activeDefs
    .map((def) => {
      const series = seriesByDef.get(def.id) ?? [];
      if (series.length === 0) return null; // no measurements anywhere
      const points = series
        .map((p) => {
          const trend = p.trend ? ` ${p.trend}` : '';
          const isCurrent = p.cycleId === cycle.id ? ' ← this cycle' : '';
          const note = p.note?.trim() ? ` — ${p.note.trim()}` : '';
          return `  - ${p.cycleLabel}: ${p.value}${trend}${note}${isCurrent}`;
        })
        .join('\n');
      const targetLine = def.target?.trim()
        ? `\n  target: ${def.target.trim()}`
        : '';
      return `- **${def.label}**${def.unit ? ` (${def.unit})` : ''}:${targetLine}\n${points}`;
    })
    .filter(Boolean) as string[];

  const kpiText = kpiBlocks.length > 0
    ? kpiBlocks.join('\n')
    : '(no KPIs recorded for this CEO yet)';

  const systemPrompt = `You are writing a personalised coaching update email on behalf of a coach named ${coachName} to their CEO client named ${ceo.name}. This email is sent after each coaching cycle to make the CEO feel heard, understood, and motivated.

## Your role
You are ghostwriting this email AS the coach. Write in first person ("I noticed...", "What stood out to me..."). The tone should be warm but direct — like a trusted advisor who genuinely cares about this person's success. The CEO should read this and think: "My coach really gets me."

## Framework Reference (use this to inform your language and framing)
${curriculumText}

## Writing guidelines
- Address the CEO by first name (${ceoFirstName}).
- Write as if the coach is speaking directly — warm, specific, no corporate jargon.
- Reference SPECIFIC things the CEO said, did, or committed to. Quote their words when possible.
- Celebrate wins concretely — not "great progress" but "you closed the COO hire in 3 weeks."
- Be honest about gaps — if they avoided something, name it kindly but clearly.
- Use Eric Partaker's language naturally: "best self," "say/do gap," "constraint," "champion proof," "momentum."
- **Anchor the email in named concepts from the Framework Reference.** Where a CEO's situation maps to a concept (Olympic Day Planner, champion proof, the 3 life domains, identity-based change, the say-do gap, the commitment loop, the constraints model), name the concept inline. Don't just summarise behaviour — connect it back to the framework so the email teaches as it reflects.
- Keep the email scannable: short paragraphs, bold for emphasis, bullet points for action items.
- End with clear next commitments and encouragement.
- **Close \`commitments\` (and \`suggestedNextSteps\` in the report) with a one-line nudge that the CEO and coach should discuss these at the next monthly coaching session.** This reinforces that the email is a starting point for the conversation, not the final word.
- When KPIs are provided, weave them into \`progressSummary\` and \`wins_and_progress\` with their numbers; don't invent metrics that aren't in the inputs.
- When prior pattern observations are provided, your \`patternObservations\` should explicitly compare to them (carrying forward, evolving, resolving) instead of treating this cycle as standalone.
- No diagnostic or therapeutic language. No legal, medical, or mental health claims.

## Suggested Resources catalog
You may pick **1–3** entries from the catalog below as next-cycle reading. Choose only ones that genuinely fit the CEO's situation this cycle. Return their ids in \`report.suggestedResourceIds\`. The same picks must drive the \`going_deeper\` email section — don't recommend in one and not the other. If nothing fits, return empty arrays in both.

${resourceCatalog || '(no class catalog available)'}

## Output Format
Return a JSON object with TWO sections — the email body (what the coach will send) and the structured report (what the operator reviews internally). Both views must be derived from the same observations, just shaped differently.

{
  // ── EMAIL VIEW (coach's voice, ready to copy/paste into Gmail) ──
  "subject_line": "Email subject line — personal and specific, not generic",
  "opening": "1-2 paragraphs — personal greeting + high-level reflection on the cycle. Make them feel seen.",
  "wins_and_progress": "What went well this cycle. Be specific — reference their actual inputs. Use bullet points for clarity.",
  "honest_feedback": "Where they got stuck, avoided, or fell short. Kind but clear. Name the pattern if there is one.",
  "key_insight": "The ONE most important observation or pattern you want them to sit with. 2-3 sentences max.",
  "commitments": "Clear numbered list of what they're committing to before next session. Include owners and deadlines where possible.",
  "going_deeper": "A brief 'Going deeper this month' block — markdown bullet list, ONE bullet per resource you picked above, in the order of report.suggestedResourceIds. Each bullet starts with the bolded class title (Class N: …), then 2–3 sentences in the coach's voice tying that resource specifically to what THIS CEO did or struggled with this cycle. Reference the actual concepts from the resource (not generic praise). If you pick zero resources, return an empty string.",
  "closing": "Encouraging sign-off. 1-2 sentences. End with the coach's name: ${coachName}",

  // ── STRUCTURED REPORT (the SCOPE-mandated 6 sections) ──
  "report": {
    "progressSummary": "1–2 paragraph plain-prose snapshot of the cycle. What was the through-line? Reference the 10x goal and where they sit relative to it.",
    "keyWins": ["Win 1 — concrete, with what changed", "Win 2 …"],
    "challenges": ["Challenge 1 — what got in the way and why it matters", "Challenge 2 …"],
    "patternObservations": "Cross-cycle patterns ONLY (recurring strengths, recurring avoidance, escalating wins). Use the previous reports above. If this is the first cycle, say so explicitly — don't fabricate a pattern from a single data point.",
    "suggestedNextSteps": ["Next step 1 — verb-led, owner-clear, time-bound", "Next step 2 …"],
    "suggestedResourceIds": ["uuid-1", "uuid-2"]
  }
}

The email keys and the report sections must be coherent — the same wins, the same challenges, the same insight, expressed for different audiences. The email is the coach's voice. The report is structured for the operator's review. The \`going_deeper\` bullet count must equal the \`suggestedResourceIds\` length and use the same picks in the same order.

Return ONLY the JSON object, no markdown fences, no extra text.`;

  const userPrompt = `## CEO Profile
- Name: ${ceo.name}
- 10x Goal: ${ceo.tenXGoal?.trim() || '(not set)'}

## Session: ${cycle.label}

### Monthly Goals & Commitments
${cycle.monthlyGoals?.trim() || '(not provided)'}

### Weekly Journals
${journalText}

### Monthly Reflection
${cycle.monthlyReflection?.trim() || '(not provided)'}

### KPIs / Metric Updates
${kpiText}

### Zoom Session Transcript
${transcriptText}
${cycle.additionalContext?.trim() ? `
### Additional Context (coach notes, emails, etc.)
${cycle.additionalContext}
` : ''}
### Previous Coaching Emails (for continuity across cycles, oldest → newest)
${previousReportsText}

### Prior Pattern Observations (cross-cycle context for patternObservations)
${priorPatternsText}
${missingWarning}

Write the coaching update email now.`;

  return { systemPrompt, userPrompt, missing };
}
