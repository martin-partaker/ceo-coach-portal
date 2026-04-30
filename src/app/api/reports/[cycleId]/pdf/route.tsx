import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { renderToBuffer } from '@react-pdf/renderer';
import { auth } from '@/lib/auth/server';
import { db } from '@/db';
import { cycles, ceos, coaches, reports } from '@/db/schema';
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

  // Coach metadata is best-effort — show the assigned coach's name as
  // the "Coach" line in the PDF subtitle when we have it.
  const [assignedCoach] = ceo.coachId
    ? await db
        .select()
        .from(coaches)
        .where(eq(coaches.id, ceo.coachId))
        .limit(1)
    : [];

  const [latestReport] = await db
    .select()
    .from(reports)
    .where(eq(reports.cycleId, cycleId))
    .limit(1);
  if (!latestReport) {
    return NextResponse.json(
      { error: 'No report has been generated for this cycle yet.' },
      { status: 404 },
    );
  }

  const json = latestReport.contentJson as ReportJson | null;

  // ── Assemble PDF data ───────────────────────────────────────────
  const pdfData: CycleReportPdfData = {
    ceo: {
      name: ceo.name,
      tenXGoal: ceo.tenXGoal ?? null,
    },
    cycle: {
      label: cycle.label,
      periodStart: cycle.periodStart ?? null,
      periodEnd: cycle.periodEnd ?? null,
      monthlyGoals: cycle.monthlyGoals ?? null,
      monthlyReflection: cycle.monthlyReflection ?? null,
    },
    coach: assignedCoach ? { name: assignedCoach.name } : null,
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
  const buffer = await renderToBuffer(<CycleReportPdf data={pdfData} />);
  const filename = `${slug(ceo.name)}_${slug(cycle.label)}_summary.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
