import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { renderToBuffer } from '@react-pdf/renderer';
import { auth } from '@/lib/auth/server';
import { db } from '@/db';
import {
  cycles,
  ceos,
  ceoKpiDefinitions,
  coaches,
  coachingTeams,
  cycleKpiValues,
  reports,
} from '@/db/schema';
import { getCycleMomentum } from '@/lib/journal/cycle-momentum';
import { IMPERSONATE_COOKIE } from '@/server/api/trpc';
import {
  CycleReportPdf,
  type CycleReportPdfData,
} from '@/lib/pdf/cycle-report-pdf';

export const dynamic = 'force-dynamic';

interface ReportJson {
  // Email view — used as a fallback when the structured `report`
  // block wasn't returned (older reports), and to drive the standalone
  // "Key Insight" PDF section that the structured shape doesn't model.
  opening?: string;
  wins_and_progress?: string;
  honest_feedback?: string;
  key_insight?: string;
  commitments?: string;
  closing?: string;
  // Structured report view (preferred when present).
  report?: {
    progressSummary?: string;
    keyWins?: string[];
    challenges?: string[];
    patternObservations?: string;
    suggestedNextSteps?: string[];
    suggestedResourceIds?: string[];
    goalSummary?: {
      tenX?: string;
      ninetyDay?: string | null;
      thirtyDay?: string | null;
      flag?: string | null;
    } | null;
    closing?: {
      sentence: string;
      nextSessionDate: string | null;
    } | null;
  };
}

/**
 * Slug a string for use in a download filename. Keeps alphanumerics +
 * spaces, collapses runs to single underscores, trims to a sane length.
 */
function slug(s: string): string {
  return s
    .replace(/[^A-Za-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;

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

  // Mirror the impersonation rule used by createTRPCContext: a real
  // super admin who has chosen to impersonate a coach should be scoped
  // to that coach. This keeps the PDF download consistent with what
  // they see in the UI.
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

  // ── Load cycle / ceo / report ───────────────────────────────────
  const [cycle] = await db
    .select()
    .from(cycles)
    .where(eq(cycles.id, cycleId))
    .limit(1);
  if (!cycle) {
    return NextResponse.json({ error: 'Cycle not found' }, { status: 404 });
  }

  const [ceo] = await db
    .select()
    .from(ceos)
    .where(eq(ceos.id, cycle.ceoId))
    .limit(1);
  if (!ceo) {
    return NextResponse.json({ error: 'CEO not found' }, { status: 404 });
  }

  // Coach-scope guard: regular coach (or impersonating admin) can only
  // download PDFs for cycles owned by their assigned CEOs.
  if (!isUnscopedAdmin && ceo.coachId !== activeCoach.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Team cycles: when cycle.teamId is set, the report subject is the
  // joint team, not the single lead CEO. Load every member so the
  // header can render "David Harding & Dave Snyder" instead of just
  // the lead member. Solo cycles fall through with members=[ceo].
  let team: typeof coachingTeams.$inferSelect | null = null;
  let members: Array<typeof ceos.$inferSelect> = [ceo];
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
        .from(ceos)
        .where(eq(ceos.teamId, cycle.teamId))
        .orderBy(asc(ceos.createdAt));
      // Lead CEO first (matches the on-screen renderer's display order),
      // then everyone else in createdAt order.
      const lead = allMembers.find((m) => m.id === cycle.ceoId);
      const rest = allMembers.filter((m) => m.id !== cycle.ceoId);
      members = lead ? [lead, ...rest] : allMembers;
    }
  }
  /** Display name for the report header — joint label for teams, single
   *  CEO for solo cycles. Pairs use " & "; trios use ", X & Y"; 4+ use
   *  ", ", "-joined with the final " & ". Matches the convention used in
   *  the drafter's subjectFullLabel helper. */
  const subjectName =
    members.length === 1
      ? members[0].name
      : members.length === 2
        ? `${members[0].name} & ${members[1].name}`
        : `${members.slice(0, -1).map((m) => m.name).join(', ')} & ${members[members.length - 1].name}`;

  // Coach metadata is best-effort — show the assigned coach's name as
  // the "Coach" line in the PDF subtitle when we have it.
  const [assignedCoach] = ceo.coachId
    ? await db
        .select()
        .from(coaches)
        .where(eq(coaches.id, ceo.coachId))
        .limit(1)
    : [];

  // Order by generatedAt DESC so a regenerate (which inserts a new
  // row) is what the PDF download picks up. Without the explicit
  // ORDER BY, Postgres returns whichever row it likes — usually the
  // first-inserted one — and downloads silently serve the stale
  // version even though the UI shows the regenerated draft.
  const [latestReport] = await db
    .select()
    .from(reports)
    .where(eq(reports.cycleId, cycleId))
    .orderBy(desc(reports.generatedAt))
    .limit(1);
  if (!latestReport) {
    return NextResponse.json(
      { error: 'No report has been generated for this cycle yet.' },
      { status: 404 },
    );
  }

  const json = latestReport.contentJson as ReportJson | null;

  // KPIs (normalized): pull this cycle's measurements with the
  // matching definition row attached, so the PDF can render label +
  // unit + target + value + trend.
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
  const thisCycleValues =
    activeDefs.length === 0
      ? []
      : await db
          .select()
          .from(cycleKpiValues)
          .where(
            and(
              eq(cycleKpiValues.cycleId, cycleId),
              inArray(
                cycleKpiValues.definitionId,
                activeDefs.map((d) => d.id),
              ),
            ),
          );
  const valueByDef = new Map(thisCycleValues.map((v) => [v.definitionId, v]));

  // Pull historical KPI values across this CEO's last few cycles so the
  // PDF can render a sparkline next to each tile. Limited to 6 points
  // — enough to show a trend, narrow enough to fit beside the value.
  const recentCycles = await db
    .select({ id: cycles.id, periodStart: cycles.periodStart, createdAt: cycles.createdAt, label: cycles.label })
    .from(cycles)
    .where(eq(cycles.ceoId, ceo.id))
    .orderBy(asc(cycles.periodStart), asc(cycles.createdAt));
  // Truncate to the trailing 6 ending at (and including) the current cycle.
  const idxOfCurrent = recentCycles.findIndex((c) => c.id === cycleId);
  const windowEnd = idxOfCurrent >= 0 ? idxOfCurrent + 1 : recentCycles.length;
  const windowStart = Math.max(0, windowEnd - 6);
  const cycleWindow = recentCycles.slice(windowStart, windowEnd);
  const cycleWindowIds = cycleWindow.map((c) => c.id);
  const historyRows =
    activeDefs.length === 0 || cycleWindowIds.length === 0
      ? []
      : await db
          .select()
          .from(cycleKpiValues)
          .where(
            and(
              inArray(cycleKpiValues.cycleId, cycleWindowIds),
              inArray(
                cycleKpiValues.definitionId,
                activeDefs.map((d) => d.id),
              ),
            ),
          );
  const historyByDef = new Map<string, Map<string, string>>();
  for (const row of historyRows) {
    let m = historyByDef.get(row.definitionId);
    if (!m) {
      m = new Map();
      historyByDef.set(row.definitionId, m);
    }
    m.set(row.cycleId, row.value);
  }

  /**
   * Parse a free-text KPI value into a number for charting. Accepts
   * "$5,000,000", "5M", "12.4%", "1.2k" etc. Returns null when nothing
   * sensible can be extracted — those points are omitted from the
   * sparkline (the line skips them).
   */
  function parseKpiValue(raw: string | undefined): number | null {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (!s) return null;
    const match = s.match(/-?\d+(?:[.,]\d+)*/);
    if (!match) return null;
    const num = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(num)) return null;
    if (/\bk\b|k\s*$/.test(s)) return num * 1_000;
    if (/\bm\b|m\s*$/.test(s)) return num * 1_000_000;
    if (/\bb\b|b\s*$/.test(s)) return num * 1_000_000_000;
    return num;
  }

  /**
   * Pull the first word out of a cycle label so the chart x-axis stays
   * compact — "Mar 2026" → "Mar". When the label has no whitespace
   * (custom labels) we fall back to the first 6 chars.
   */
  function shortCycleLabel(full: string): string {
    const trimmed = full.trim();
    if (!trimmed) return '';
    const first = trimmed.split(/\s+/)[0];
    return first.length > 0 ? first.slice(0, 6) : trimmed.slice(0, 6);
  }

  const pdfKpis = activeDefs
    .map((def) => {
      const v = valueByDef.get(def.id);
      if (!v) return null;
      const hist = historyByDef.get(def.id);
      const history = cycleWindow
        .map((c) => {
          const raw = hist?.get(c.id);
          const num = parseKpiValue(raw);
          return num !== null
            ? { label: shortCycleLabel(c.label), value: num }
            : null;
        })
        .filter((p): p is { label: string; value: number } => p !== null);
      return {
        label: def.label,
        value: v.value,
        trend: (v.trend as 'up' | 'down' | 'flat' | null) ?? undefined,
        note: v.note ?? undefined,
        history,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // ── Momentum Check well-being averages ──────────────────────────
  // Parsed from the weekly-journal 1–10 scores (energy / focus / stress /
  // highest-leverage), averaged for this month with a stoplight colour,
  // plus the prior month when it has data. Shared helper so the PDF and
  // the on-screen report render identical numbers.
  const momentum = await getCycleMomentum(cycleId);

  // ── Assemble PDF data ───────────────────────────────────────────
  // Team-aware 10x goal: the team row holds the shared goal for team
  // cycles; fall back to the lead CEO's goal when no team is set.
  const tenXGoal = team?.tenXGoal ?? ceo.tenXGoal ?? null;

  const pdfData: CycleReportPdfData = {
    ceo: {
      name: subjectName,
      tenXGoal,
    },
    cycle: {
      label: cycle.label,
      periodStart: cycle.periodStart ?? null,
      periodEnd: cycle.periodEnd ?? null,
      monthlyGoals: cycle.monthlyGoals ?? null,
      monthlyReflection: cycle.monthlyReflection ?? null,
      kpis: pdfKpis,
    },
    coach: assignedCoach ? { name: assignedCoach.name } : null,
    momentum,
    report: json?.report ?? {},
    email: {
      opening: json?.opening,
      wins_and_progress: json?.wins_and_progress,
      honest_feedback: json?.honest_feedback,
      key_insight: json?.key_insight,
      commitments: json?.commitments,
    },
    generatedAt: latestReport.generatedAt ?? null,
  };

  // ── Render + stream ─────────────────────────────────────────────
  // Wrap renderToBuffer so any react-pdf failure (bad child shape,
  // SVG primitive misuse, font issue) surfaces as a 500 JSON response
  // instead of bubbling up into Next.js's default HTML error page —
  // the client uses `<a download>` which would otherwise save that
  // HTML body as a `.html`/`.txt` file. The full stack lands in the
  // dev server stderr so we can debug.
  let buffer: Buffer;
  try {
    buffer = await renderToBuffer(<CycleReportPdf data={pdfData} />);
  } catch (err) {
    console.error('[reports/pdf] renderToBuffer failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: 'Failed to render PDF',
        detail: message,
        cycleId,
      },
      { status: 500 },
    );
  }

  // Filename mirrors the header subject — for team cycles use the team
  // name when available (cleaner than two CEO names with " & " joining
  // them); fall back to the joint subjectName otherwise.
  const filenameSubject = team?.name ?? subjectName;
  const filename = `${slug(filenameSubject)}_${slug(cycle.label)}_summary.pdf`;
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
