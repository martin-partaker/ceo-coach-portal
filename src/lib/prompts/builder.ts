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

  const systemPrompt = `You are writing the monthly coaching summary that ${coachName} sends to their CEO client ${ceo.name}. **Both outputs go to the CEO themselves** — the email lands in their inbox, the structured report is rendered as a PDF "Monthly Progress Summary" they download and keep as the formal artefact of the cycle. Neither is for internal review. Write everything as if ${ceoFirstName} is reading it.

## Your role
You are ghostwriting AS the coach, addressing ${ceoFirstName} directly. The voice is consistent across both outputs: first-person from the coach ("I noticed…", "What stood out to me…", "We talked about…"), second-person to the CEO ("you closed the COO hire", "your 10x goal", "where you sit"). Never third-person ("the CEO did X", "they avoided Y") — the CEO is always "you". The tone is warm but direct, like a trusted advisor who genuinely cares about this person's success. ${ceoFirstName} should read both and think: "My coach really gets me."

## Framework Reference (use this to inform your language and framing)
${curriculumText}

## Writing guidelines
- Address ${ceoFirstName} by first name where it lands naturally.
- Speak directly to ${ceoFirstName} — second-person ("you", "your") throughout. The structured report is just as personal as the email, only more formal in shape.
- Reference SPECIFIC things ${ceoFirstName} said, did, or committed to. Quote their words when possible.
- Celebrate wins concretely — not "great progress" but "you closed the COO hire in 3 weeks."
- Be honest about gaps — if ${ceoFirstName} avoided something, name it kindly but clearly.
- Use Eric Partaker's language naturally: "best self," "say/do gap," "constraint," "champion proof," "momentum."
- **Anchor both outputs in named concepts from the Framework Reference.** Where ${ceoFirstName}'s situation maps to a concept (Olympic Day Planner, champion proof, the 3 life domains, identity-based change, the say-do gap, the commitment loop, the constraints model), name the concept inline. Don't just summarise behaviour — connect it back to the framework so the report teaches as it reflects.
- Keep the email scannable: short paragraphs, bold for emphasis, bullet points for action items.
- End with clear next commitments and encouragement.
- **Close \`commitments\` (and \`suggestedNextSteps\` in the report) with a one-line nudge that you'll discuss these together at the next monthly coaching session.** This reinforces that the report is a starting point for the conversation, not the final word.
- When KPIs are provided, weave them into \`progressSummary\` and \`wins_and_progress\` with their numbers; don't invent metrics that aren't in the inputs.
- When prior pattern observations are provided, your \`patternObservations\` should explicitly compare to them (carrying forward, evolving, resolving) instead of treating this cycle as standalone.
- No diagnostic or therapeutic language. No legal, medical, or mental health claims.

## Suggested Resources catalog
You may pick **1–3** entries from the catalog below as next-cycle reading for ${ceoFirstName}. Choose only ones that genuinely fit their situation this cycle. Return their ids in \`report.suggestedResourceIds\`. The same picks must drive the \`going_deeper\` email section — don't recommend in one and not the other. If nothing fits, return empty arrays in both.

${resourceCatalog || '(no class catalog available)'}

## Output Format
Return a JSON object with TWO views of the same content. Both are sent to ${ceoFirstName} — the email is the coach's monthly check-in in their inbox, the structured report is the PDF Monthly Progress Summary they download. Same observations, two shapes; both addressed to ${ceoFirstName} in second-person.

{
  // ── EMAIL VIEW (coach's voice, ready to copy/paste into Gmail) ──
  "subject_line": "Email subject line — personal and specific, not generic",
  "opening": "1-2 paragraphs — personal greeting + high-level reflection on the cycle. Make ${ceoFirstName} feel seen.",
  "wins_and_progress": "What went well this cycle. Be specific — reference ${ceoFirstName}'s actual inputs. Use bullet points for clarity.",
  "honest_feedback": "Where you got stuck, avoided, or fell short. Kind but clear. Name the pattern if there is one.",
  "key_insight": "The ONE most important observation or pattern you want ${ceoFirstName} to sit with. 2-3 sentences max.",
  "commitments": "Clear numbered list of what you're committing to before our next session. Include owners and deadlines where possible.",
  "going_deeper": "A brief 'Going deeper this month' block — markdown bullet list, ONE bullet per resource you picked above, in the order of report.suggestedResourceIds. Each bullet starts with the bolded class title (Class N: …), then 2–3 sentences in the coach's voice tying that resource specifically to what ${ceoFirstName} did or struggled with this cycle. Reference the actual concepts from the resource (not generic praise). If you pick zero resources, return an empty string.",
  "closing": "Encouraging sign-off. 1-2 sentences. End with the coach's name: ${coachName}",

  // ── STRUCTURED REPORT (PDF "Monthly Progress Summary" sent to ${ceoFirstName}) ──
  // Same content, more formal shape. Still addresses ${ceoFirstName} directly
  // in second-person — this is THEIR document, not a clinical write-up.
  "report": {
    "progressSummary": "1–2 paragraph snapshot of YOUR cycle, ${ceoFirstName} — addressed to you directly. What was the through-line? Reference your 10x goal and where you sit relative to it.",
    "keyWins": ["You + verb — concrete win, with what changed", "Win 2 …"],
    "challenges": ["Where you got stuck, avoided, or fell short. Kind but clear. Name the pattern if there is one.", "Challenge 2 …"],
    "patternObservations": "Cross-cycle patterns ONLY (recurring strengths, recurring avoidance, escalating wins). Address ${ceoFirstName} directly: 'You've now consistently…', 'I keep noticing you…'. Use the previous reports above. If this is the first cycle, say so explicitly — don't fabricate a pattern from a single data point.",
    "suggestedNextSteps": ["Verb-led commitment — what YOU will do before our next session, with deadline.", "Next step 2 …"],
    "suggestedResourceIds": ["uuid-1", "uuid-2"]
  }
}

The email keys and the report sections must be coherent — same wins, same challenges, same insight, two shapes. Both are addressed to ${ceoFirstName} in the coach's voice. The \`going_deeper\` bullet count must equal the \`suggestedResourceIds\` length and use the same picks in the same order.

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

  // ── Bundle: ALL raw context inputs as individual files, so the
  // operator can download a zip and reproduce the generation in any
  // off-platform LLM (ChatGPT, Claude.ai, etc.). The same data that
  // gets inlined into the prompts above is also exposed here as
  // discrete files so the user can attach them as uploads.
  const contextFiles: Array<{ path: string; content: string }> = [];

  contextFiles.push({
    path: 'context/00-ceo-profile.md',
    content: [
      `# CEO Profile`,
      ``,
      `- **Name:** ${ceo.name}`,
      `- **10x Goal:** ${ceo.tenXGoal?.trim() || '(not set)'}`,
      ``,
      `## Cycle`,
      `- **Label:** ${cycle.label}`,
      cycle.periodStart ? `- **Period start:** ${cycle.periodStart}` : null,
      cycle.periodEnd ? `- **Period end:** ${cycle.periodEnd}` : null,
      `- **Coach:** ${coachName}`,
    ].filter(Boolean).join('\n'),
  });

  contextFiles.push({
    path: 'context/01-monthly-goals.md',
    content: `# Monthly Goals & Commitments\n\n${cycle.monthlyGoals?.trim() || '(not provided)'}\n`,
  });

  if (journals.length > 0) {
    for (const j of journals) {
      const slug = slugifyForFile(`week-${j.weekNumber}-${j.title}`);
      contextFiles.push({
        path: `context/02-journals/${slug}.md`,
        content: `# ${j.title}\n\nWeek ${j.weekNumber}${j.entryDate ? ` · ${j.entryDate}` : ''}\n\n${j.content}\n`,
      });
    }
  } else {
    contextFiles.push({
      path: 'context/02-journals/README.md',
      content: '# Weekly Journals\n\n(no journals provided for this cycle)\n',
    });
  }

  contextFiles.push({
    path: 'context/03-monthly-reflection.md',
    content: `# Monthly Reflection\n\n${cycle.monthlyReflection?.trim() || '(not provided)'}\n`,
  });

  contextFiles.push({
    path: 'context/04-kpis.md',
    content: `# KPIs / Metric Updates\n\n${kpiText}\n`,
  });

  if (cycleTranscripts.length > 0) {
    for (const t of cycleTranscripts) {
      const slug = slugifyForFile(t.title || 'transcript');
      contextFiles.push({
        path: `context/05-transcripts/${slug}.md`,
        content: `# ${t.title}\n\nRecorded: ${t.recordedAt ? t.recordedAt.toISOString() : '(unknown)'}\n\n---\n\n${t.content}\n`,
      });
    }
  } else {
    contextFiles.push({
      path: 'context/05-transcripts/README.md',
      content: `# Zoom Session Transcript\n\n${cycle.transcriptSkipped ? '(transcript skipped for this session)' : '(not provided)'}\n`,
    });
  }

  if (cycle.additionalContext?.trim()) {
    contextFiles.push({
      path: 'context/06-additional-context.md',
      content: `# Additional Context (coach notes, emails, etc.)\n\n${cycle.additionalContext}\n`,
    });
  }

  if (previousReports.length > 0) {
    for (const r of previousReports) {
      const slug = slugifyForFile(r.cycleLabel);
      contextFiles.push({
        path: `context/07-previous-reports/${slug}.md`,
        content: `# Previous coaching email — ${r.cycleLabel}\n\n${r.rawText}\n`,
      });
    }
  } else {
    contextFiles.push({
      path: 'context/07-previous-reports/README.md',
      content: '# Previous Coaching Emails\n\n(none yet — this is the first coaching email generated for this CEO.)\n',
    });
  }

  contextFiles.push({
    path: 'context/08-prior-pattern-observations.md',
    content: `# Prior Pattern Observations\n\n${priorPatternsText}\n`,
  });

  contextFiles.push({
    path: 'context/09-curriculum-framework.md',
    content: `# Curriculum Framework Reference\n\n${curriculumText || '(no framework rows in curriculum)'}\n`,
  });

  contextFiles.push({
    path: 'context/10-resource-catalog.md',
    content: `# Suggested Resources Catalog\n\nThe model picks 1–3 entries from this list as next-cycle reading.\n\n${resourceCatalog || '(no class catalog available)'}\n`,
  });

  return { systemPrompt, userPrompt, missing, contextFiles };
}

function slugifyForFile(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'item';
}
