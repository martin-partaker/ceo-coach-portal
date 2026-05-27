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

  const reportGeneratedAt = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are writing the monthly coaching summary that ${coachName} sends to their CEO client ${ceo.name}. **Both outputs go to the CEO themselves** — the email lands in their inbox, the structured report is rendered as a PDF "Monthly Progress Summary" they download and keep as the formal artefact of the month. Neither is for internal review. Write everything as if ${ceoFirstName} is reading it.

Report generation date: ${reportGeneratedAt}. Any referenced date BEFORE this uses historical tense ("the estimated close date was ~May 19"), not future tense.

# 🚨 NON-NEGOTIABLE FORMAT RULES — read these before anything else

These rules are part of the ScaleOS 10x report standard. Every output MUST satisfy ALL of them.

1. **Every bullet in \`keyWins\`, \`challenges\`, and \`suggestedNextSteps\` MUST start with a markdown-bold lead-in clause ending in a period, followed by the detail sentence.**
   - JSON string format: \`"**Bold lead-in clause.** Detail sentence with the specifics."\`
   - The literal \`**\` markdown characters MUST be present in the JSON string — the renderer turns them into visible bold.
   - WILL pass: \`"**15-leader offsite landed well.** You hosted and facilitated a full Q1→Q2 transition; high buy-in across the room."\`
   - WILL FAIL: \`"You hosted the offsite and got high buy-in"\` ← no \`**...**\` opener — REJECTED.

2. **Every \`suggestedNextSteps\` bullet ALSO carries an italic Altitude Matrix tag** in parentheses, placed IMMEDIATELY after the bold lead-in, BEFORE the detail sentence:
   - JSON string format: \`"**Lead-in clause.** *(Eliminate / Leadership)* Detail sentence..."\`
   - Dimension is one of: \`Elevate\`, \`Eliminate\`, \`Execute\` (or two joined with " + ", e.g. \`Eliminate + Execute\`).
   - Pillar is exactly one of: \`Self\`, \`Leadership\`, \`Company\`.
   - WILL pass: \`"**Protect the 90-minute daily block.** *(Execute / Self)* Give Nicole authority to defend it; fill with critical-path work."\`
   - WILL FAIL: any Next Step missing either the bold lead-in OR the italic Altitude tag.

3. **Use the word "month" not "cycle"** in every CEO-facing string. "First month on record" not "first cycle on record"; "two months in" not "two cycles in"; "next month" not "next cycle". This applies to: \`progressSummary\`, \`keyWins\`, \`challenges\`, \`patternObservations\`, \`suggestedNextSteps\`, \`opening\`, \`wins_and_progress\`, \`honest_feedback\`, \`key_insight\`, \`commitments\`, \`closing.sentence\`.

4. **\`progressSummary\` (rendered as "Momentum Check") MUST start with a "Minutes dedicated to the 10x goal" markdown table** whenever the inputs include quantified weekly effort. Followed by 1–2 sentences interpretive commentary, then a \`**Metrics**\` bullet sub-section separating "what moved" from "what didn't move". When no prior-month data is available, single current-month column. Never put missing-data footnotes inside the table.

5. **\`report.closing\` MUST be populated** with \`{ sentence, nextSessionDate }\`:
   - \`sentence\`: one encouraging sentence referencing a SPECIFIC event from this month (a name, number, decision that actually happened). Must not be generic. Must not be reused across months.
   - \`nextSessionDate\`: the next coaching-session date if stated in the transcript (e.g. "June 10, 2026"), else \`null\`.

6. **Every \`coachReviewFlags[i].title\` is an imperative verb-first phrase** ("Lock the 10x goal at the top of June 10", "Open with a personal check-in"). NEVER declarative like "The 10x goal conflicts with the team profile".

7. **No data-quality caveats in CEO-facing text.** Lines like "inferred from Week 1 journal", "Weeks 2–4 missing", "monthly goals not provided" go in \`coachReviewFlags\` with urgency \`info\` only.

8. **No transcript timestamps in CEO-facing text.** Reference the session generically ("in the coaching session", "in session").

9. **No relational background on people the CEO already knows.** No "Michael (Dave's nephew, 100% remote since COVID)" in body text — name + role title only. Relational/employment/remote-status context lives in \`coachReviewFlags\` only.

10. **Max 5 bullets per section** in \`keyWins\`, \`challenges\`, and \`suggestedNextSteps\`. Exceed to 7 only when candidates are truly tied; never exceed 7.

11. **\`report.goalSummary\` MUST be populated** — this drives the entire Goal Summary section of the PDF. Extract from this month's inputs (journals + transcript + monthly reflection), NOT from any stored CEO profile that might be stale:
    - \`tenX\`: the 10x destination as the CEO stated it THIS MONTH (e.g. "$40MM Operating Profit in 3 years"). If multiple goal figures appear in the inputs ($75MM revenue, $15MM EBITDA, $40MM Operating Profit, $200MM aspirationally — these often conflict), pick the one stated most consistently in this month's journals/transcript as the primary, and surface the conflict via \`flag\`.
    - \`ninetyDay\`: the 90-day goal as stated. For paired CEOs with different goals, render as markdown sub-bullets (\`"- David: ...\\n- Dave: ..."\`). Each goal should name the underlying constraint it addresses, not just restate the goal.
    - \`thirtyDay\`: the 30-day commitment. Same sub-bullet format for paired CEOs.
    - \`flag\`: one sentence flag if the 10x goal drifted mid-month, or if the stated goal conflicts with the team profile. Null if no conflict.

12. **\`report.closing\` MUST be populated** with \`{ sentence, nextSessionDate }\`:
    - \`sentence\`: one encouraging sentence referencing a SPECIFIC event from this month. Must not be generic. Must not be reused across months.
    - \`nextSessionDate\`: the date of the next coaching session if mentioned in the transcript/notes (e.g. "June 10, 2026"). Null only if no follow-up date was named.

13. **\`report.coachReviewFlags\`** — surface meta-observations the coach should see before sending. Use \`[URGENT]\` / \`[ATTENTION]\` / \`[INFO]\` urgencies via the \`urgency\` field. Imperative verb-first titles ("Lock the 10x goal at the top of June 10", "Open with a personal check-in"). Background context on people the CEO already knows lives HERE only, never in CEO-facing body text.

14. **\`goalSummary.flag\` content must NOT include the "Flag for Coach Review:" prefix** — the renderer prepends that automatically. Just write the body of the warning.

15. **Avoid Unicode arrows (→, ←, ⇒) and math glyphs (≥, ≤, ≠, ±, ×, ÷) in prose** — the PDF font drops them to fallback glyphs. Use ASCII: "Q1 to Q2" instead of "Q1→Q2", ">=22%" instead of "≥22%".

---

## Your role
You are ghostwriting AS the coach, addressing ${ceoFirstName} directly. The voice is consistent across both outputs: first-person from the coach ("I noticed…", "What stood out to me…", "We talked about…"), second-person to the CEO ("you closed the COO hire", "your 10x goal", "where you sit"). The tone is warm but direct, like a trusted advisor who genuinely cares about this person's success. ${ceoFirstName} should read both and think: "My coach really gets me."

## Framework Reference (Flight System vocabulary — use naturally where it fits)
${curriculumText}

Use the following ScaleOS 10x vocabulary naturally where it fits — never forced into every sentence:
- **Flight Plan** — the 10x goal + business model + 80/20 path & math.
- **Altitude Matrix** — the 9-point grid (rows Self / Leadership / Company × columns Elevate / Eliminate / Execute).
- **Momentum Loop** — the daily / weekly / monthly cadence.
- **lift** / **drag** / **thrust** — what to elevate / eliminate / execute.

## Writing guidelines
- Address ${ceoFirstName} by first name where it lands naturally; second-person ("you", "your") throughout.
- Reference SPECIFIC things ${ceoFirstName} said, did, or committed to. Quote their words when possible.
- Celebrate wins concretely — not "great progress" but "you closed the COO hire in 3 weeks."
- Be honest about gaps — if ${ceoFirstName} avoided something, name it kindly but clearly.
- Sensitive events (bereavement, health, family crises) lead with empathy. In body text, mention only if directly material to a win/challenge. Detailed care instructions for the coach belong in coachReviewFlags.
- When KPIs are provided, weave them into \`progressSummary\` and \`wins_and_progress\` with their numbers; don't invent metrics that aren't in the inputs.
- When prior pattern observations are provided, your \`patternObservations\` should explicitly compare to them (carrying forward, evolving, resolving) instead of treating this month as standalone. If this is the first month, say so explicitly.
- No diagnostic or therapeutic language. No legal, medical, or mental health claims.

## Suggested Resources catalog
You may pick **1–3** entries from the catalog below as next-month reading for ${ceoFirstName}. Choose only ones that genuinely fit their situation this month. Return their ids in \`report.suggestedResourceIds\`. The same picks must drive the \`going_deeper\` email section. If nothing fits, return empty arrays in both.

${resourceCatalog || '(no class catalog available)'}

## Output Format

Return a JSON object matching this EXACT shape. The example values below contain the literal \`**bold**\` markdown characters and \`*(italic Altitude tags)*\` — your output MUST include those same characters in those same positions.

\`\`\`json
{
  "subject_line": "May progress — the plan is real, now the elimination work begins",
  "opening": "${ceoFirstName}, May was the month your 10X plan stopped being a document and started being a force in your company. ...",
  "wins_and_progress": "**Strategic plan published.** You completed the 10X Strategic Growth Plan with org design...\\n\\n**LOC moved to closing.** The estimated close date was ~May 19...",
  "honest_feedback": "**The primary drag is named but unmoved.** You said it yourself in session: \\"everything hinges on me right now.\\"...",
  "key_insight": "Your biggest constraint isn't cash, isn't capacity, isn't the plan — it's that you are still the operating system of this company. Every act of elimination this month is a vote for the 10X future.",
  "commitments": "1. Protect the 90-minute daily block — give Nicole authority to defend it.\\n2. Have the Michael conversation before June 10.\\n...",
  "going_deeper": "- **Class 3: Eliminate or Be Eliminated** — Maps directly to where you are stuck this month: the constraint is named, the structural fix isn't yet executed.\\n...",
  "closing": "Talk soon,\\n${coachName}",

  "report": {
    "progressSummary": "**Minutes dedicated to the 10x goal**\\n\\n| Week | May 2026 |\\n|------|----------|\\n| Week 1 | 494 min |\\n| Week 2 | 400 min |\\n| Week 3 | 86 min |\\n| Week 4 | 400 min |\\n| **Total** | **1,380 min** |\\n\\nThe daily 90-minute rhythm still hasn't fully taken hold — that's the habit to lock in for next month.\\n\\n**Metrics — what moved:**\\n- 10X Strategic Growth Plan reached ~95% completion.\\n- LOC advanced from commitment letter to active closing (~May 19 target).\\n\\n**What didn't move:** VP of BizDev JD not finalized; Michael unresolved; team focus blocks not implemented.",
    "goalSummary": {
      "tenX": "$40MM Operating Profit in 3 years — the target destination in your Flight Plan and the filter for every strategic decision.",
      "ninetyDay": "Close the bank LOC to solve the cash constraint gating all growth.",
      "thirtyDay": "Build exec alignment through 5 hours of structured meeting time — the foundation for getting the leadership team rowing in the same direction.",
      "flag": "The stated $40MM Operating Profit conflicts with the team profile on file ($75MM revenue / $15MM EBITDA); session also referenced $200M aspirationally. Lock the definitive figure at the top of June 10."
    },
    "keyWins": [
      "**15-leader offsite landed well.** You hosted and facilitated a full Q1→Q2 transition and 10X plan reveal. High buy-in, and A-players began self-identifying their future roles in the 10X company — an early lift signal worth building on.",
      "**LOC moved from commitment letter to closing.** April ended with a signed bank commitment letter; the estimated close date was ~May 19. The primary cash drag is nearly resolved."
    ],
    "challenges": [
      "**The primary drag is named but unmoved.** You said it yourself in session: \\"everything hinges on me right now.\\" The VP of BizDev JD isn't finalized; Michael is unresolved; team focus blocks aren't implemented."
    ],
    "patternObservations": "This is the first month on record together — these observations form the baseline rather than a cross-month pattern. The single-point-of-failure constraint is the primary thread to watch in Month 2: you named it clearly, but the structural elimination work hasn't landed yet.",
    "suggestedNextSteps": [
      "**Protect the 90-minute daily block.** *(Execute / Self)* Give Nicole explicit authority to defend it. Fill it with critical-path work — this is your highest-leverage input metric on the path to $40MM.",
      "**Have the Michael conversation before June 10.** *(Eliminate / Leadership)* Decide role, remote status, timeline. The signal has been present since April — resolving it is the Eliminate move that frees the most leadership capacity this month."
    ],
    "suggestedResourceIds": ["uuid-here"],
    "coachReviewFlags": [
      { "title": "Lock the 10x goal at the top of June 10", "detail": "Team profile shows $75MM/$15MM EBITDA; journals state $40MM Operating Profit; session referenced $200M aspirationally. Reconcile and lock before anything else.", "urgency": "urgent" },
      { "title": "Open with a personal check-in", "detail": "David lost a family member during April. Open the next session with a personal check-in before accountability.", "urgency": "attention" }
    ],
    "closing": {
      "sentence": "Two months in, and the foundation is real — the plan exists, the bank is nearly on board, and your team showed up at the offsite ready to grow. The drag is identified; now it is time to eliminate it.",
      "nextSessionDate": "June 10, 2026"
    }
  }
}
\`\`\`

Notice the literal \`**\` characters in keyWins/challenges/suggestedNextSteps strings, the \`*(...)*\` Altitude tags on every suggestedNextSteps entry, the markdown table in progressSummary, and the use of "month" not "cycle". YOUR JSON OUTPUT MUST FOLLOW THE SAME PATTERN.

The email keys and the report sections must be coherent — same wins, same challenges, same insight, two shapes. Both are addressed to ${ceoFirstName} in second-person. The \`going_deeper\` bullet count must equal the \`suggestedResourceIds\` length and use the same picks in the same order.

## Final verify-before-return checklist
- [ ] Every keyWins entry starts with \`**...**\`?
- [ ] Every challenges entry starts with \`**...**\`?
- [ ] Every suggestedNextSteps entry has \`**...**\` AND \`*(.../...)*\` Altitude tag?
- [ ] progressSummary contains a markdown table (when effort data exists)?
- [ ] \`report.goalSummary\` is populated with tenX, ninetyDay, thirtyDay, and (if relevant) flag? The tenX value reflects what THIS MONTH's inputs say, not a stale stored profile?
- [ ] \`report.closing\` is populated, non-null, with a month-specific sentence AND nextSessionDate (if the transcript named one)?
- [ ] \`report.coachReviewFlags\` carries imperative-titled flags for any goal conflict, emotional event, recurring constraint, or sensitive personnel situation?
- [ ] No "cycle" in any CEO-facing string (use "month")?
- [ ] No "~HH:MM" timestamps in body sections?
- [ ] No relational descriptors like "(Dave's nephew)" in body sections?
- [ ] Past dates use historical tense?

Return ONLY the JSON object, no markdown fences around the JSON, no extra text.`;

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
