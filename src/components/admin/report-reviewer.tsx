'use client';

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  BookOpen,
  Check,
  Copy,
  Download,
  Eye,
  FileText,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  ListChecks,
  AlertTriangle,
  TrendingUp,
  Trash2,
  X,
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Props {
  cycleId: string;
  ceoName: string;
  cycleLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Shape of `reports.contentJson` for prompt-version 2+. Older reports
 * (v1, pre-pivot) only have the email keys; the structured report block
 * is undefined and we hide that tab.
 */
interface ReportJson {
  // Email view
  subject_line?: string;
  opening?: string;
  wins_and_progress?: string;
  honest_feedback?: string;
  key_insight?: string;
  commitments?: string;
  going_deeper?: string;
  closing?: string;
  // Structured 6-section report (SCOPE.v2 §5)
  report?: {
    progressSummary?: string;
    keyWins?: string[];
    challenges?: string[];
    patternObservations?: string;
    suggestedNextSteps?: string[];
    suggestedResourceIds?: string[];
  };
}

type Tab = 'email' | 'report';

export function ReportReviewer({
  cycleId,
  ceoName,
  cycleLabel,
  open,
  onOpenChange,
}: Props) {
  const utils = trpc.useUtils();
  const report = trpc.reports.getForCycle.useQuery(
    { cycleId },
    { enabled: open, staleTime: 30_000 }
  );
  const regenerate = trpc.reports.generate.useMutation({
    onSuccess: () => {
      utils.reports.getForCycle.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
      utils.roster.cycleDetail.invalidate({ cycleId });
    },
  });

  const data = report.data;
  const json = (data?.contentJson ?? null) as ReportJson | null;
  const subject = json?.subject_line ?? '';
  const body = data?.rawText ?? '';
  const structured = json?.report ?? null;
  const hasReport =
    !!structured &&
    !!(
      structured.progressSummary ||
      structured.keyWins?.length ||
      structured.challenges?.length ||
      structured.patternObservations ||
      structured.suggestedNextSteps?.length ||
      structured.suggestedResourceIds?.length
    );

  // Default to the structured report — that's the source of truth
  // operators review and approve. The email view is the deliverable
  // they ship after, so it's the secondary tab. Falls back to 'email'
  // if the report doesn't have a structured block (older runs, or the
  // model didn't emit one).
  const [tab, setTab] = useState<Tab>('report');
  useEffect(() => {
    if (!hasReport && tab === 'report') setTab('email');
  }, [hasReport, tab]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Review report — {cycleLabel}
          </SheetTitle>
          <SheetDescription>
            Generated for {ceoName}
            {data?.generatedAt && (
              <>
                {' '}
                · {new Date(data.generatedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </>
            )}
          </SheetDescription>
        </SheetHeader>

        {data && hasReport && (
          <div className="border-b border-border px-5">
            <div className="inline-flex gap-1">
              <TabButton active={tab === 'report'} onClick={() => setTab('report')} icon={<BookOpen className="h-3.5 w-3.5" />}>
                Structured report
              </TabButton>
              <TabButton active={tab === 'email'} onClick={() => setTab('email')} icon={<Mail className="h-3.5 w-3.5" />}>
                Email
              </TabButton>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {report.isLoading && (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {!report.isLoading && !data && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
              No report has been generated yet.
            </div>
          )}

          {data && tab === 'email' && (
            <div className="space-y-5">
              {subject && (
                <Section title="Subject line" content={subject}>
                  <p className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm leading-relaxed text-foreground">
                    {subject}
                  </p>
                </Section>
              )}
              <Section title="Email body" content={body}>
                <pre className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 p-3 font-sans text-[13px] leading-relaxed text-foreground/90">
                  {body}
                </pre>
              </Section>
              <ReportFooter modelUsed={data.modelUsed} promptVersion={data.promptVersion} />
              {regenerate.error && (
                <p className="text-xs text-destructive">{regenerate.error.message}</p>
              )}
            </div>
          )}

          {data && tab === 'report' && structured && (
            <StructuredReportView
              reportId={data.id}
              structured={structured}
              goingDeeper={json?.going_deeper ?? ''}
            />
          )}
        </div>

        <SheetFooter className="flex-row items-center gap-2">
          <span className="flex-1" />
          {data && (
            <>
              <Button asChild variant="outline" size="sm">
                {/* Plain anchor with `download` so the browser saves
                    the file directly. The route handler streams the
                    rendered PDF with a Content-Disposition filename. */}
                <a
                  href={`/api/reports/${cycleId}/pdf`}
                  download
                  rel="noreferrer"
                >
                  <Download className="mr-1.5 h-3 w-3" />
                  Download PDF
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => regenerate.mutate({ cycleId })}
                disabled={regenerate.isPending}
              >
                {regenerate.isPending ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3 w-3" />
                )}
                Re-generate
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
        active
          ? 'border-b-2 border-foreground text-foreground'
          : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground'
      )}
      style={{ marginBottom: -1 }}
    >
      {icon}
      {children}
    </button>
  );
}

function StructuredReportView({
  reportId,
  structured,
  goingDeeper,
}: {
  reportId: string;
  structured: NonNullable<ReportJson['report']>;
  goingDeeper: string;
}) {
  const ids = useMemo(
    () => structured.suggestedResourceIds ?? [],
    [structured.suggestedResourceIds],
  );
  const resources = trpc.reports.resolveSuggestedResources.useQuery(
    { ids },
    { enabled: ids.length > 0, staleTime: 60_000 },
  );

  const reportPlainText = useMemo(() => {
    const parts: string[] = [];
    if (structured.progressSummary) parts.push(`Progress Summary\n${structured.progressSummary}`);
    if (structured.keyWins?.length)
      parts.push(`Key Wins\n${structured.keyWins.map((w) => `- ${w}`).join('\n')}`);
    if (structured.challenges?.length)
      parts.push(`Challenges & Constraints\n${structured.challenges.map((c) => `- ${c}`).join('\n')}`);
    if (structured.patternObservations)
      parts.push(`Pattern Observations\n${structured.patternObservations}`);
    if (structured.suggestedNextSteps?.length)
      parts.push(`Suggested Next Steps\n${structured.suggestedNextSteps.map((s) => `- ${s}`).join('\n')}`);
    if (resources.data && resources.data.length > 0) {
      parts.push(
        `Suggested Resources\n${resources.data
          .map((r) => `- ${r.title}${r.summary ? ` — ${r.summary}` : ''}`)
          .join('\n')}`,
      );
    }
    return parts.join('\n\n');
  }, [structured, resources.data]);

  // Top-of-report at-a-glance counts so the operator can see the shape
  // of this cycle's output without scrolling the whole sheet.
  const winsCount = structured.keyWins?.length ?? 0;
  const challengesCount = structured.challenges?.length ?? 0;
  const stepsCount = structured.suggestedNextSteps?.length ?? 0;
  const resourcesCount = ids.length;

  return (
    <div className="space-y-4">
      {/* Stats strip + whole-report copy. Counts give the operator a
          one-glance sense of "this report has 5 wins, 3 challenges, …"
          without scrolling. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <StatChip
            icon={<Sparkles className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
            label="wins"
            count={winsCount}
          />
          <StatChip
            icon={<AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" />}
            label="challenges"
            count={challengesCount}
          />
          <StatChip
            icon={<ListChecks className="h-3 w-3 text-blue-600 dark:text-blue-400" />}
            label="next steps"
            count={stepsCount}
          />
          <StatChip
            icon={<BookOpen className="h-3 w-3 text-purple-600 dark:text-purple-400" />}
            label="resources"
            count={resourcesCount}
          />
        </div>
        <CopyButton content={reportPlainText} label="Copy whole report" />
      </div>

      <EditableProseSection
        title="Progress Summary"
        reportId={reportId}
        field="progressSummary"
        value={structured.progressSummary ?? ''}
        tone="neutral"
        icon={<TrendingUp className="h-3.5 w-3.5" />}
      />

      <EditableListSection
        title="Key Wins"
        reportId={reportId}
        field="keyWins"
        items={structured.keyWins ?? []}
        tone="green"
        icon={<Sparkles className="h-3.5 w-3.5" />}
      />

      <EditableListSection
        title="Challenges & Constraints"
        reportId={reportId}
        field="challenges"
        items={structured.challenges ?? []}
        tone="amber"
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
      />

      <EditableProseSection
        title="Pattern Observations"
        reportId={reportId}
        field="patternObservations"
        value={structured.patternObservations ?? ''}
        tone="purple"
        icon={<Eye className="h-3.5 w-3.5" />}
      />

      <EditableListSection
        title="Suggested Next Steps"
        reportId={reportId}
        field="suggestedNextSteps"
        items={structured.suggestedNextSteps ?? []}
        tone="blue"
        icon={<ListChecks className="h-3.5 w-3.5" />}
      />

      <SuggestedResourcesEditor
        reportId={reportId}
        ids={ids}
        resources={resources.data ?? []}
        loading={resources.isLoading}
      />

      <GoingDeeperEditor reportId={reportId} initialValue={goingDeeper} />
    </div>
  );
}

/** Tone tokens for the structured-report section cards. Each section
 *  type gets its own subtle accent so the eye can scan the report for
 *  the kind of content it wants without reading section titles. */
type SectionTone = 'neutral' | 'green' | 'amber' | 'purple' | 'blue';

const TONE_STYLES: Record<
  SectionTone,
  { accent: string; bg: string; titleText: string; iconText: string }
> = {
  neutral: {
    accent: 'border-l-border',
    bg: 'bg-muted/15',
    titleText: 'text-foreground',
    iconText: 'text-muted-foreground',
  },
  green: {
    accent: 'border-l-emerald-500/60',
    bg: 'bg-emerald-500/5 dark:bg-emerald-500/10',
    titleText: 'text-emerald-700 dark:text-emerald-400',
    iconText: 'text-emerald-600 dark:text-emerald-400',
  },
  amber: {
    accent: 'border-l-amber-500/60',
    bg: 'bg-amber-500/5 dark:bg-amber-500/10',
    titleText: 'text-amber-700 dark:text-amber-400',
    iconText: 'text-amber-600 dark:text-amber-400',
  },
  purple: {
    accent: 'border-l-purple-500/60',
    bg: 'bg-purple-500/5 dark:bg-purple-500/10',
    titleText: 'text-purple-700 dark:text-purple-400',
    iconText: 'text-purple-600 dark:text-purple-400',
  },
  blue: {
    accent: 'border-l-blue-500/60',
    bg: 'bg-blue-500/5 dark:bg-blue-500/10',
    titleText: 'text-blue-700 dark:text-blue-400',
    iconText: 'text-blue-600 dark:text-blue-400',
  },
};

function StatChip({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      <span className="font-mono text-foreground/80 tabular-nums">{count}</span>{' '}
      <span>{label}</span>
    </span>
  );
}

/**
 * Coach curation: edit the Suggested Resources list. The AI's picks
 * are the starting point; the coach can remove a row, swap one out, or
 * add a search-picked resource. Persisted via `reports.update` which
 * also re-derives the email's rawText so "Copy email" stays in sync.
 */
function SuggestedResourcesEditor({
  reportId,
  ids,
  resources,
  loading,
}: {
  reportId: string;
  ids: string[];
  resources: Array<{
    id: string;
    title: string;
    summary: string | null;
    classNumber: number | null;
    section: string | null;
    slug: string | null;
  }>;
  loading: boolean;
}) {
  const utils = trpc.useUtils();
  const update = trpc.reports.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.getForCycle.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
    },
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const catalog = trpc.reports.searchCurriculum.useQuery(
    { q: search, limit: 25 },
    { enabled: pickerOpen, staleTime: 60_000 },
  );

  function setIds(nextIds: string[]) {
    update.mutate({ reportId, suggestedResourceIds: nextIds });
  }

  function remove(id: string) {
    setIds(ids.filter((x) => x !== id));
  }

  function add(id: string) {
    if (ids.includes(id)) return;
    setIds([...ids, id]);
    setPickerOpen(false);
    setSearch('');
  }

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Suggested Resources
        </p>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {ids.length} pick{ids.length === 1 ? '' : 's'}
        </span>
        {update.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => setPickerOpen((o) => !o)}
        >
          <Plus className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>

      {loading && (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading curriculum…
        </div>
      )}
      {!loading && resources.length === 0 && !pickerOpen && (
        <div className="rounded-md border border-dashed border-border bg-muted/10 px-3 py-2 text-[12px] italic text-muted-foreground">
          No resources picked yet — click Add to choose one from the curriculum.
        </div>
      )}
      {!loading && resources.length > 0 && (
        <div className="grid gap-2">
          {resources.map((r) => (
            <div
              key={r.id}
              className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed"
            >
              <span
                className="mt-0.5 inline-flex shrink-0 items-center rounded border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                title={r.section ?? undefined}
              >
                {r.classNumber !== null ? `Class ${r.classNumber}` : 'Framework'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {r.slug ? (
                    <a
                      href={`/c/${r.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                      title="Open curriculum page"
                    >
                      {r.title}
                    </a>
                  ) : (
                    r.title
                  )}
                </p>
                {r.summary && (
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{r.summary}</p>
                )}
              </div>
              <button
                type="button"
                className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => remove(r.id)}
                title="Remove from suggested resources"
                aria-label="Remove resource"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {pickerOpen && (
        <div className="mt-2 rounded-md border border-border bg-muted/20 p-2">
          <div className="mb-2 flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the curriculum…"
              className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] outline-none focus:ring-0"
            />
            <button
              type="button"
              onClick={() => {
                setPickerOpen(false);
                setSearch('');
              }}
              className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Close"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {catalog.isLoading && (
              <div className="px-2 py-3 text-[12px] text-muted-foreground">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
            {!catalog.isLoading &&
              (catalog.data ?? []).filter((r) => !ids.includes(r.id)).length === 0 && (
                <div className="px-2 py-3 text-[12px] italic text-muted-foreground">
                  No matches.
                </div>
              )}
            {(catalog.data ?? [])
              .filter((r) => !ids.includes(r.id))
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => add(r.id)}
                  className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[12.5px] leading-snug transition-colors hover:bg-background"
                >
                  <span
                    className="mt-0.5 inline-flex shrink-0 items-center rounded border border-border bg-background px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                    title={r.section ?? undefined}
                  >
                    {r.kind === 'class' && r.classNumber !== null
                      ? `Class ${r.classNumber}`
                      : 'Framework'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">{r.title}</p>
                    {r.summary && (
                      <p className="line-clamp-2 text-[11.5px] text-muted-foreground">
                        {r.summary}
                      </p>
                    )}
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Coach-editable Going Deeper email block. Debounced autosave; the
 * server re-derives the email's rawText so the Email tab's Copy buttons
 * stay in sync after edits.
 */
function GoingDeeperEditor({
  reportId,
  initialValue,
}: {
  reportId: string;
  initialValue: string;
}) {
  const utils = trpc.useUtils();
  const update = trpc.reports.update.useMutation({
    onSuccess: () => utils.reports.getForCycle.invalidate(),
  });

  const [value, setValue] = useState(initialValue);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Reset when the underlying report changes (e.g. re-generate).
  useEffect(() => {
    setValue(initialValue);
    setSavedAt(null);
  }, [initialValue, reportId]);

  // Debounced save.
  const dirty = value !== initialValue;
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      update.mutate(
        { reportId, going_deeper: value },
        { onSuccess: () => setSavedAt(Date.now()) },
      );
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, dirty]);

  const showSaved = savedAt && Date.now() - savedAt < 3000 && !dirty;

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Going Deeper (email block)
        </p>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          rendered into the email above the closing
        </span>
        <span className="flex-1" />
        {update.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        {!update.isPending && dirty && (
          <span className="text-[10px] text-muted-foreground">unsaved</span>
        )}
        {!update.isPending && !dirty && showSaved && (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <Check className="h-2.5 w-2.5" /> saved
          </span>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        placeholder="One bullet per resource — bold the class title, then 2–3 sentences in the coach's voice tying it to this CEO's cycle."
        className="w-full whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed text-foreground/90 outline-none focus:border-foreground/40"
      />
    </section>
  );
}

function Section({
  title,
  content,
  children,
  extraAction,
  tone = 'neutral',
  icon,
}: {
  title: string;
  content: string;
  children: React.ReactNode;
  /** Slot for a per-section affordance (e.g. an Edit pencil) rendered
   *  alongside the Copy button. Used by EditableProseSection /
   *  EditableListSection so the editor can sit in the same header. */
  extraAction?: React.ReactNode;
  tone?: SectionTone;
  icon?: React.ReactNode;
}) {
  const t = TONE_STYLES[tone];
  return (
    <section
      className={cn(
        'group rounded-lg border border-l-4 border-border px-3.5 py-3',
        t.accent,
        t.bg,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className={cn('flex items-center gap-1.5', t.titleText)}>
          {icon && <span className={t.iconText}>{icon}</span>}
          <p className="text-[11px] font-semibold uppercase tracking-wider">
            {title}
          </p>
        </div>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {extraAction}
          <CopyButton content={content} />
        </div>
      </div>
      {children}
    </section>
  );
}

/* ─────────────────── Editable structured-report sections ──────────────────
 * Each editable section has the same look as its readonly counterpart
 * (Section + Prose / BulletList) plus a pencil affordance in the header.
 * Click pencil → swap render to Textarea → Save / Cancel. Save sends
 * the field back through `reports.update`, which re-derives `rawText`
 * server-side so the Email tab and PDF stay coherent.
 */

function EditableProseSection({
  title,
  reportId,
  field,
  value,
  tone,
  icon,
}: {
  title: string;
  reportId: string;
  field: 'progressSummary' | 'patternObservations';
  value: string;
  tone?: SectionTone;
  icon?: React.ReactNode;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  // Keep draft in sync if the upstream value changes (e.g. caller
  // re-fetched after a regenerate) and we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const update = trpc.reports.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.getForCycle.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
      setEditing(false);
    },
  });

  // Don't render an empty readonly section — but still allow editing
  // into existence via a small "Add" affordance.
  if (!editing && !value.trim()) {
    return (
      <EmptySectionShell
        title={title}
        tone={tone}
        icon={icon}
        onAdd={() => {
          setDraft('');
          setEditing(true);
        }}
      />
    );
  }

  if (!editing) {
    return (
      <Section
        title={title}
        content={value}
        tone={tone}
        icon={icon}
        extraAction={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${title}`}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        }
      >
        <Prose>{value}</Prose>
      </Section>
    );
  }

  return (
    <Section title={title} content={draft} tone={tone} icon={icon} extraAction={null}>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.max(4, Math.min(14, draft.split('\n').length + 1))}
        className="text-[13px] leading-relaxed"
        autoFocus
      />
      {update.error && (
        <p className="mt-2 text-[11px] text-destructive">{update.error.message}</p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => {
            setDraft(value);
            setEditing(false);
          }}
          disabled={update.isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => update.mutate({ reportId, [field]: draft })}
          disabled={update.isPending || draft === value}
        >
          {update.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Check className="mr-1 h-3 w-3" />
          )}
          Save
        </Button>
      </div>
    </Section>
  );
}

function EditableListSection({
  title,
  reportId,
  field,
  items,
  tone,
  icon,
}: {
  title: string;
  reportId: string;
  field: 'keyWins' | 'challenges' | 'suggestedNextSteps';
  items: string[];
  tone?: SectionTone;
  icon?: React.ReactNode;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  // Edit-mode draft is one bullet per line, with a leading "- " stripped
  // for cleaner editing. We re-split on save.
  const initialDraft = useMemo(() => items.join('\n'), [items]);
  const [draft, setDraft] = useState(initialDraft);

  useEffect(() => {
    if (!editing) setDraft(initialDraft);
  }, [initialDraft, editing]);

  const update = trpc.reports.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.getForCycle.invalidate(),
        utils.roster.cycleSummary.invalidate(),
      ]);
      setEditing(false);
    },
  });

  function save() {
    const next = draft
      .split('\n')
      .map((l) => l.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean);
    update.mutate({ reportId, [field]: next });
  }

  if (!editing && items.length === 0) {
    return (
      <EmptySectionShell
        title={title}
        tone={tone}
        icon={icon}
        onAdd={() => {
          setDraft('');
          setEditing(true);
        }}
      />
    );
  }

  const copyContent = items.map((i) => `- ${i}`).join('\n');

  if (!editing) {
    return (
      <Section
        title={title}
        content={copyContent}
        tone={tone}
        icon={icon}
        extraAction={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${title}`}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        }
      >
        <BulletList items={items} numbered={field === 'suggestedNextSteps'} />
      </Section>
    );
  }

  return (
    <Section title={title} content={draft} tone={tone} icon={icon} extraAction={null}>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.max(4, Math.min(14, draft.split('\n').length + 1))}
        placeholder="One bullet per line"
        className="text-[13px] leading-relaxed"
        autoFocus
      />
      <p className="mt-1 text-[10px] text-muted-foreground">
        One bullet per line. Leading <span className="font-mono">-</span> /
        <span className="font-mono"> *</span> /
        <span className="font-mono"> •</span> are stripped on save.
      </p>
      {update.error && (
        <p className="mt-2 text-[11px] text-destructive">{update.error.message}</p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => {
            setDraft(initialDraft);
            setEditing(false);
          }}
          disabled={update.isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={save}
          disabled={update.isPending || draft === initialDraft}
        >
          {update.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Check className="mr-1 h-3 w-3" />
          )}
          Save
        </Button>
      </div>
    </Section>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
      {children}
    </p>
  );
}

function BulletList({
  items,
  numbered,
}: {
  items: string[];
  numbered?: boolean;
}) {
  return (
    <ul className="grid gap-1.5 text-[13px] leading-relaxed text-foreground/90">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          {numbered ? (
            <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 font-mono text-[10px] tabular-nums text-foreground/70">
              {i + 1}
            </span>
          ) : (
            <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
          )}
          <span className="whitespace-pre-wrap">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Shown when an editable section has no content yet. Same chrome as
 * a populated Section (tone-tinted card + icon) but with a single
 * "Add" CTA in the body — gives the operator a clear way to fill in
 * a missing block from the AI without losing the visual rhythm of
 * the report.
 */
function EmptySectionShell({
  title,
  tone = 'neutral',
  icon,
  onAdd,
}: {
  title: string;
  tone?: SectionTone;
  icon?: React.ReactNode;
  onAdd: () => void;
}) {
  const t = TONE_STYLES[tone];
  return (
    <section
      className={cn(
        'rounded-lg border border-l-4 border-dashed border-border px-3.5 py-3',
        t.accent,
        'bg-background/40',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className={cn('flex items-center gap-1.5 text-muted-foreground')}>
          {icon && <span className={t.iconText}>{icon}</span>}
          <p className="text-[11px] font-semibold uppercase tracking-wider">
            {title}
          </p>
          <span className="text-[11px] italic text-muted-foreground/70">
            · empty
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onAdd}
        >
          <Plus className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>
    </section>
  );
}

function CopyButton({
  content,
  label,
}: {
  content: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn('h-7 px-2 text-xs')}
      onClick={copy}
      disabled={!content}
    >
      {copied ? (
        <>
          <Check className="mr-1 h-3 w-3" /> Copied
        </>
      ) : (
        <>
          <Copy className="mr-1 h-3 w-3" /> {label ?? 'Copy'}
        </>
      )}
    </Button>
  );
}

function ReportFooter({
  modelUsed,
  promptVersion,
}: {
  modelUsed: string;
  promptVersion: number | null;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      Generated by <span className="font-mono">{modelUsed}</span>
      {promptVersion ? (
        <>
          {' '}
          · prompt v<span className="font-mono">{promptVersion}</span>
        </>
      ) : null}
    </div>
  );
}
