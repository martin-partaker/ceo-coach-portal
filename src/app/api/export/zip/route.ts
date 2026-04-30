import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import JSZip from 'jszip';
import { auth } from '@/lib/auth/server';
import { db } from '@/db';
import {
  actionItems as actionItemsTable,
  ceoEmailAliases,
  ceoKpiDefinitions,
  ceos,
  coaches,
  cycleKpiValues,
  cycles,
  journalEntries,
  reports,
  transcripts,
} from '@/db/schema';
import { IMPERSONATE_COOKIE } from '@/server/api/trpc';

export const dynamic = 'force-dynamic';
// PDFs and zips can be large; grant the route the upper-tier serverless
// timeout in case a coach has many CEOs/cycles.
export const maxDuration = 300;

/* ─────────────────────── Helpers ─────────────────────── */

/** Slug a string for filesystem use inside the zip. Keeps unicode
 *  letters out of paths since some unzippers struggle with them. */
function slug(s: string, fallback = 'untitled'): string {
  const cleaned = s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60);
  return cleaned || fallback;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Stable date-only ISO so the filename is the date and the date alone. */
function isoDateOnly(d: Date | string | null | undefined): string {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Render a Date as a friendly local string for human-facing files. */
function fmtLocal(d: Date | null | undefined): string {
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Markdown-escape a label (parentheses / brackets / pipes that might
 *  break tables). Lightweight — full markdown sanitisation isn't needed
 *  since the audience is humans reading the file. */
function md(s: string | null | undefined): string {
  return (s ?? '').trim();
}

/** Cheap CSV cell — wraps in quotes when needed and doubles quotes. */
function csvCell(s: string | null | undefined): string {
  const v = (s ?? '').trim();
  if (!v) return '';
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/* ─────────────────────── Route ─────────────────────── */

export async function GET() {
  // ── Auth ────────────────────────────────────────────────────────
  const { data: session } = await auth.getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [realCoach] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.neonAuthUserId, session.user.id))
    .limit(1);
  if (!realCoach) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Impersonation honours the same rule as the PDF route + tRPC: a real
  // super admin who's chosen to impersonate is scoped to that coach.
  let activeCoach = realCoach;
  let isImpersonating = false;
  if (realCoach.isSuperAdmin) {
    const cookieStore = await cookies();
    const impersonateId = cookieStore.get(IMPERSONATE_COOKIE)?.value;
    if (impersonateId) {
      const [target] = await db
        .select()
        .from(coaches)
        .where(eq(coaches.id, impersonateId))
        .limit(1);
      if (target) {
        activeCoach = target;
        isImpersonating = true;
      }
    }
  }
  const isUnscopedAdmin = realCoach.isSuperAdmin && !isImpersonating;

  // ── Resolve scope ───────────────────────────────────────────────
  // Unscoped super admin: every CEO + every coach. Otherwise: only
  // CEOs assigned to activeCoach. Mirrors roster.cycleSummary's scope
  // filter so the export never leaks data the caller couldn't see in
  // the UI.
  const ceoBaseQuery = db
    .select({ ceo: ceos, coach: coaches })
    .from(ceos)
    .leftJoin(coaches, eq(ceos.coachId, coaches.id));
  const ceoRows = isUnscopedAdmin
    ? await ceoBaseQuery
    : await ceoBaseQuery.where(eq(ceos.coachId, activeCoach.id));

  // ── Collect every related row in bulk for the resolved CEOs ───
  const ceoIds = ceoRows.map((r) => r.ceo.id);

  const [
    aliasRows,
    cycleRows,
    journalRows,
    transcriptRows,
    actionItemRows,
    reportRows,
    kpiDefs,
    kpiValues,
  ] = ceoIds.length === 0
    ? [[], [], [], [], [], [], [], []]
    : await Promise.all([
        db
          .select()
          .from(ceoEmailAliases)
          .where(inArray(ceoEmailAliases.ceoId, ceoIds)),
        db
          .select()
          .from(cycles)
          .where(inArray(cycles.ceoId, ceoIds))
          .orderBy(asc(cycles.periodStart), asc(cycles.createdAt)),
        // The journal/transcript/etc. tables don't carry ceoId
        // directly — they FK on cycleId. We pull every cycle id for
        // these CEOs into an inArray below to keep this single-pass.
        db
          .select()
          .from(journalEntries)
          .where(
            inArray(
              journalEntries.cycleId,
              db
                .select({ id: cycles.id })
                .from(cycles)
                .where(inArray(cycles.ceoId, ceoIds)),
            ),
          )
          .orderBy(asc(journalEntries.weekNumber)),
        db
          .select()
          .from(transcripts)
          .where(
            inArray(
              transcripts.cycleId,
              db
                .select({ id: cycles.id })
                .from(cycles)
                .where(inArray(cycles.ceoId, ceoIds)),
            ),
          )
          .orderBy(desc(transcripts.recordedAt)),
        db
          .select()
          .from(actionItemsTable)
          .where(
            inArray(
              actionItemsTable.cycleId,
              db
                .select({ id: cycles.id })
                .from(cycles)
                .where(inArray(cycles.ceoId, ceoIds)),
            ),
          )
          .orderBy(asc(actionItemsTable.createdAt)),
        db
          .select()
          .from(reports)
          .where(
            inArray(
              reports.cycleId,
              db
                .select({ id: cycles.id })
                .from(cycles)
                .where(inArray(cycles.ceoId, ceoIds)),
            ),
          )
          .orderBy(desc(reports.generatedAt)),
        db
          .select()
          .from(ceoKpiDefinitions)
          .where(inArray(ceoKpiDefinitions.ceoId, ceoIds))
          .orderBy(
            asc(ceoKpiDefinitions.ceoId),
            asc(ceoKpiDefinitions.sortOrder),
          ),
        db
          .select()
          .from(cycleKpiValues)
          .where(
            inArray(
              cycleKpiValues.cycleId,
              db
                .select({ id: cycles.id })
                .from(cycles)
                .where(inArray(cycles.ceoId, ceoIds)),
            ),
          ),
      ]);

  // Group everything by their parent so the per-CEO/per-cycle
  // assembly below is a clean lookup rather than a nested filter.
  const aliasesByCeo = new Map<string, string[]>();
  for (const a of aliasRows) {
    const list = aliasesByCeo.get(a.ceoId) ?? [];
    list.push(a.email);
    aliasesByCeo.set(a.ceoId, list);
  }
  const cyclesByCeo = new Map<string, typeof cycleRows>();
  for (const c of cycleRows) {
    const list = cyclesByCeo.get(c.ceoId) ?? [];
    list.push(c);
    cyclesByCeo.set(c.ceoId, list);
  }
  const journalsByCycle = new Map<string, typeof journalRows>();
  for (const j of journalRows) {
    const list = journalsByCycle.get(j.cycleId) ?? [];
    list.push(j);
    journalsByCycle.set(j.cycleId, list);
  }
  const transcriptsByCycle = new Map<string, typeof transcriptRows>();
  for (const t of transcriptRows) {
    const list = transcriptsByCycle.get(t.cycleId) ?? [];
    list.push(t);
    transcriptsByCycle.set(t.cycleId, list);
  }
  const actionsByCycle = new Map<string, typeof actionItemRows>();
  for (const a of actionItemRows) {
    const list = actionsByCycle.get(a.cycleId) ?? [];
    list.push(a);
    actionsByCycle.set(a.cycleId, list);
  }
  const reportsByCycle = new Map<string, (typeof reportRows)[number]>();
  // Latest report wins (reportRows already ordered desc by generatedAt).
  for (const r of reportRows) {
    if (!reportsByCycle.has(r.cycleId)) reportsByCycle.set(r.cycleId, r);
  }
  const kpiDefsByCeo = new Map<string, typeof kpiDefs>();
  for (const d of kpiDefs) {
    const list = kpiDefsByCeo.get(d.ceoId) ?? [];
    list.push(d);
    kpiDefsByCeo.set(d.ceoId, list);
  }
  const kpiValuesByCycle = new Map<string, typeof kpiValues>();
  for (const v of kpiValues) {
    const list = kpiValuesByCycle.get(v.cycleId) ?? [];
    list.push(v);
    kpiValuesByCycle.set(v.cycleId, list);
  }
  // Definition-id → label, used to render KPI rows where we only have
  // the value row and need the human label.
  const defLabelById = new Map(kpiDefs.map((d) => [d.id, d.label]));

  // ── Build the zip ──────────────────────────────────────────────
  const zip = new JSZip();
  const exportedAt = new Date();
  const exportRoot = isUnscopedAdmin ? 'all_coaches' : slug(activeCoach.name);

  // Top-level README — table of contents + scope info.
  const ceoCount = ceoRows.length;
  const cycleCount = cycleRows.length;
  const reportCount = reportRows.length;
  const journalCount = journalRows.length;
  const transcriptCount = transcriptRows.length;

  zip.file(
    'README.md',
    [
      `# Coach Portal export`,
      ``,
      `Exported ${exportedAt.toLocaleString()}`,
      ``,
      `**Scope:** ${
        isUnscopedAdmin
          ? `All ${ceoCount} CEOs across every coach (unscoped admin export).`
          : `${ceoCount} CEOs assigned to **${activeCoach.name}**.`
      }${isImpersonating ? ` _(super admin impersonating)_` : ''}`,
      ``,
      `## Counts`,
      ``,
      `| Type | Count |`,
      `| --- | --- |`,
      `| CEOs | ${ceoCount} |`,
      `| Cycles | ${cycleCount} |`,
      `| Reports | ${reportCount} |`,
      `| Journal entries | ${journalCount} |`,
      `| Transcripts | ${transcriptCount} |`,
      `| KPI definitions | ${kpiDefs.length} |`,
      `| KPI values | ${kpiValues.length} |`,
      ``,
      `## Folder structure`,
      ``,
      `\`\`\``,
      `${exportRoot}/`,
      `├── coach.json            — caller metadata`,
      `└── ceos/`,
      `    └── <ceo>/`,
      `        ├── profile.json     — CEO row + aliases`,
      `        ├── 10x-goal.md      — long-lived 10x statement`,
      `        ├── kpi-history.csv  — long-format value history`,
      `        └── cycles/`,
      `            └── <cycle>/`,
      `                ├── overview.md     — label, dates, goals, reflection`,
      `                ├── journals/       — one .md per weekly entry`,
      `                ├── transcripts/    — one .md per session`,
      `                ├── action-items.md — committed next steps`,
      `                ├── kpis.csv        — values for this cycle`,
      `                ├── report.md       — generated report (markdown)`,
      `                └── report.json     — raw structured contentJson`,
      `\`\`\``,
      ``,
      `_All times are in the server's local timezone unless otherwise noted._`,
      ``,
    ].join('\n'),
  );

  // Caller metadata.
  zip.file(
    `${exportRoot}/coach.json`,
    JSON.stringify(
      {
        exported_at: exportedAt.toISOString(),
        scope: isUnscopedAdmin ? 'all' : 'coach',
        is_impersonating: isImpersonating,
        active_coach: {
          id: activeCoach.id,
          name: activeCoach.name,
          email: activeCoach.email,
          is_super_admin: activeCoach.isSuperAdmin,
        },
        real_coach: isImpersonating
          ? {
              id: realCoach.id,
              name: realCoach.name,
              email: realCoach.email,
            }
          : undefined,
      },
      null,
      2,
    ),
  );

  // Per-CEO content.
  for (const { ceo, coach: ceoCoach } of ceoRows) {
    const ceoFolder = `${exportRoot}/ceos/${slug(ceo.name)}_${shortId(ceo.id)}`;

    zip.file(
      `${ceoFolder}/profile.json`,
      JSON.stringify(
        {
          id: ceo.id,
          name: ceo.name,
          email: ceo.email,
          aliases: aliasesByCeo.get(ceo.id) ?? [],
          ten_x_goal: ceo.tenXGoal,
          ten_x_goal_updated_at: ceo.tenXGoalUpdatedAt?.toISOString() ?? null,
          coach: ceoCoach
            ? { id: ceoCoach.id, name: ceoCoach.name, email: ceoCoach.email }
            : null,
          created_at: ceo.createdAt.toISOString(),
        },
        null,
        2,
      ),
    );

    zip.file(
      `${ceoFolder}/10x-goal.md`,
      [
        `# ${ceo.name} — 10x Goal`,
        ``,
        ceo.tenXGoal?.trim() || '_(not set)_',
        ``,
        ceo.tenXGoalUpdatedAt
          ? `_Last updated ${fmtLocal(ceo.tenXGoalUpdatedAt)}_`
          : '',
      ].join('\n'),
    );

    // KPI history CSV — long-format so you can pivot it.
    const ceoKpis = kpiDefsByCeo.get(ceo.id) ?? [];
    const ceoCycles = cyclesByCeo.get(ceo.id) ?? [];
    const ceoCycleIds = new Set(ceoCycles.map((c) => c.id));
    const csvLines = [
      'kpi_label,kpi_kind,kpi_unit,kpi_target,cycle_label,cycle_period_end,value,trend,note',
    ];
    for (const def of ceoKpis) {
      // Pull values for this definition across cycles owned by this CEO.
      const valuesForDef = kpiValues.filter(
        (v) =>
          v.definitionId === def.id && ceoCycleIds.has(v.cycleId),
      );
      const cycleById = new Map(ceoCycles.map((c) => [c.id, c]));
      const sorted = [...valuesForDef].sort((a, b) => {
        const ca = cycleById.get(a.cycleId);
        const cb = cycleById.get(b.cycleId);
        const ak = ca?.periodEnd ?? ca?.createdAt.toISOString() ?? '';
        const bk = cb?.periodEnd ?? cb?.createdAt.toISOString() ?? '';
        return ak < bk ? -1 : 1;
      });
      for (const v of sorted) {
        const cy = cycleById.get(v.cycleId);
        csvLines.push(
          [
            csvCell(def.label),
            csvCell(def.kind),
            csvCell(def.unit),
            csvCell(def.target),
            csvCell(cy?.label ?? ''),
            csvCell(cy?.periodEnd ?? ''),
            csvCell(v.value),
            csvCell(v.trend),
            csvCell(v.note),
          ].join(','),
        );
      }
    }
    if (csvLines.length > 1) {
      zip.file(`${ceoFolder}/kpi-history.csv`, csvLines.join('\n'));
    }

    // Per-cycle content.
    for (const cycle of ceoCycles) {
      const cycleFolder = `${ceoFolder}/cycles/${slug(cycle.label)}_${shortId(cycle.id)}`;

      // Overview.
      const periodLine =
        cycle.periodStart && cycle.periodEnd
          ? `${cycle.periodStart} → ${cycle.periodEnd}`
          : 'no dates set';
      const overview = [
        `# ${cycle.label}`,
        ``,
        `**CEO:** ${ceo.name}`,
        `**Period:** ${periodLine}`,
        `**Created:** ${fmtLocal(cycle.createdAt)}`,
        ``,
        `## Monthly Goals`,
        ``,
        md(cycle.monthlyGoals) || '_(not provided)_',
        ``,
        `## Monthly Reflection`,
        ``,
        md(cycle.monthlyReflection) || '_(not provided)_',
        ``,
      ];
      if (cycle.additionalContext?.trim()) {
        overview.push(`## Additional Context (coach notes, etc.)`, '');
        overview.push(cycle.additionalContext.trim(), '');
      }
      zip.file(`${cycleFolder}/overview.md`, overview.join('\n'));

      // Journals — one file per entry, named by the date when present.
      const journals = journalsByCycle.get(cycle.id) ?? [];
      for (const j of journals) {
        const dateBit = isoDateOnly(j.entryDate ?? j.createdAt) || `week-${j.weekNumber}`;
        const fname = `${dateBit}_${slug(j.title || `week-${j.weekNumber}`)}.md`;
        zip.file(
          `${cycleFolder}/journals/${fname}`,
          [
            `# ${j.title}`,
            ``,
            j.entryDate
              ? `**Entry date:** ${j.entryDate}`
              : `**Week:** ${j.weekNumber}`,
            ``,
            j.content?.trim() || '_(empty)_',
            ``,
          ].join('\n'),
        );
      }

      // Transcripts — one file per session.
      const cycleTx = transcriptsByCycle.get(cycle.id) ?? [];
      for (const t of cycleTx) {
        const dateBit =
          isoDateOnly(t.recordedAt ?? t.createdAt) || 'session';
        const fname = `${dateBit}_${slug(t.title || 'session')}.md`;
        zip.file(
          `${cycleFolder}/transcripts/${fname}`,
          [
            `# ${t.title || 'Session transcript'}`,
            ``,
            t.recordedAt ? `**Recorded:** ${fmtLocal(t.recordedAt)}` : '',
            t.duration ? `**Duration:** ${t.duration} minutes` : '',
            t.zoomMeetingId ? `**Zoom meeting id:** ${t.zoomMeetingId}` : '',
            ``,
            '---',
            ``,
            t.content?.trim() || '_(empty)_',
            ``,
          ]
            .filter((l) => l !== '')
            .join('\n'),
        );
      }

      // Action items.
      const actions = actionsByCycle.get(cycle.id) ?? [];
      if (actions.length > 0) {
        const actionLines = [`# Action items — ${cycle.label}`, ``];
        for (const a of actions) {
          const tick =
            a.status === 'done' ? '[x]' : a.status === 'dropped' ? '[~]' : '[ ]';
          const due = a.dueAt ? ` _(due ${a.dueAt})_` : '';
          const owner = a.owner?.trim() ? ` — **${a.owner.trim()}**` : '';
          const ai = a.aiSuggested ? ` _(AI suggested)_` : '';
          actionLines.push(`- ${tick}${owner} ${a.item}${due}${ai}`);
        }
        zip.file(`${cycleFolder}/action-items.md`, actionLines.join('\n'));
      }

      // KPI values for this cycle.
      const cycleKpiVals = kpiValuesByCycle.get(cycle.id) ?? [];
      if (cycleKpiVals.length > 0) {
        const kpiLines = ['kpi_label,value,trend,note'];
        for (const v of cycleKpiVals) {
          kpiLines.push(
            [
              csvCell(defLabelById.get(v.definitionId) ?? v.definitionId),
              csvCell(v.value),
              csvCell(v.trend),
              csvCell(v.note),
            ].join(','),
          );
        }
        zip.file(`${cycleFolder}/kpis.csv`, kpiLines.join('\n'));
      }

      // Generated report — markdown for humans + raw JSON for tooling.
      const report = reportsByCycle.get(cycle.id);
      if (report) {
        zip.file(
          `${cycleFolder}/report.json`,
          JSON.stringify(
            {
              id: report.id,
              cycle_id: report.cycleId,
              generated_at: report.generatedAt.toISOString(),
              model_used: report.modelUsed,
              prompt_version: report.promptVersion,
              content_json: report.contentJson,
            },
            null,
            2,
          ),
        );
        zip.file(
          `${cycleFolder}/report.md`,
          [
            `# Coaching report — ${cycle.label}`,
            ``,
            `**For:** ${ceo.name}`,
            `**Generated:** ${fmtLocal(report.generatedAt)}`,
            `**Model:** ${report.modelUsed}`,
            ``,
            '---',
            ``,
            report.rawText?.trim() || '_(empty)_',
            ``,
          ].join('\n'),
        );
      }
    }
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const filename = `coach-portal_${slug(exportRoot)}_${exportedAt
    .toISOString()
    .slice(0, 10)}.zip`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
