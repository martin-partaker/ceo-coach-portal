'use client';

import { useEffect, useState, useMemo } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Loader2,
  Mail,
  Pencil,
  AlertTriangle,
  Plus,
  Sparkles,
  RefreshCw,
  FilePlus,
  Download,
  ChevronDown,
  ChevronRight,
  Target,
  CalendarRange,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/api/root';
import type {
  RosterCeoSummary,
  RosterCycle,
} from '@/server/api/routers/roster';
import { CONTENT_TYPE_DOT, fmtShortDate, PHASE_DOT, deriveCycleLabel } from './roster-v2-shared';
import { CycleEditDialog } from './roster-v2-cycle-edit-dialog';
import { CycleCreateDialog } from './roster-v2-cycle-create-dialog';
import { NotesEditor } from './roster-v2-notes-editor';
import { CycleFieldEditor } from './roster-v2-cycle-field-editor';
import { CycleKpiEditor } from './roster-v2-kpi-editor';
import { ActionItemsEditableList } from './roster-v2-action-items';
import { PromptInspector } from './prompt-inspector';
import { ManualTranscriptDialog } from './manual-transcript-dialog';
import { AddWeekDialog } from './add-week-dialog';
import { ReportDocumentModal } from './report-modal/report-document-modal';
import { ZoomImportDialog } from '@/components/cycles/zoom-import-dialog';
import { RosterEditCeoDialog } from './roster-edit-ceo-dialog';

interface Props {
  summary: RosterCeoSummary;
  cycles: RosterCycle[];
  activeCycleId: string;
  onActiveCycleIdChange: (id: string) => void;
  /** Bumped each time the parent row's "Review →" button is clicked.
   *  Used as a one-shot trigger to auto-open the report reviewer dialog
   *  inside this workspace (no page navigation). */
  reviewKey?: number;
}

/**
 * Inline workspace shown when a row is expanded. Mirrors the standalone
 * cycle page but denser. The user can switch between this CEO's cycles via
 * tabs at the top. Detail data is fetched on-demand per cycle.
 *
 * `activeCycleId` is owned by the parent row so the inline Gantt above can
 * highlight the same cycle the tab strip is showing.
 */
export function CycleWorkspace({
  summary,
  cycles,
  activeCycleId,
  onActiveCycleIdChange,
  reviewKey,
}: Props) {
  const [newCycleOpen, setNewCycleOpen] = useState(false);
  const cycle = cycles.find((c) => c.id === activeCycleId);
  const cycleIndex = cycles.findIndex((c) => c.id === activeCycleId);
  const prevCycle = cycleIndex > 0 ? cycles[cycleIndex - 1] : null;

  if (!cycle) return null;

  return (
    <div className="border-t border-border bg-muted/20">
      {/* Cycle tabs — horizontally scrollable when a CEO has many
          cycles. The right-edge fade is a visible scroll affordance
          (macOS hides scrollbars by default, so without this users
          can't see there's more content offscreen). */}
      <div
        className="relative border-b border-border"
        style={{ paddingTop: 8 }}
      >
        <div
          className="flex items-center gap-1 overflow-x-auto px-12 pb-px [scrollbar-color:var(--muted-foreground)_transparent] [scrollbar-width:thin]"
        >
          {cycles.map((c) => {
            const active = c.id === activeCycleId;
            return (
              <button
                key={c.id}
                onClick={() => onActiveCycleIdChange(c.id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
                  active
                    ? 'border-b-2 text-foreground'
                    : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground'
                )}
                style={{
                  borderBottomColor: active ? 'var(--foreground)' : 'transparent',
                  marginBottom: -1,
                }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: PHASE_DOT[c.phase] }}
                />
                {deriveCycleLabel(c)}
              </button>
            );
          })}
          <button
            onClick={() => setNewCycleOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            style={{ marginBottom: -1 }}
          >
            <Plus className="h-3 w-3" /> New cycle
          </button>
          <span className="shrink-0 pr-12" />
        </div>
        {/* Right-edge gradient cue: more cycles offscreen. Pointer-events
            none so it doesn't block the rightmost tab. */}
        <div
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-background to-transparent"
        />
      </div>

      <CycleBody
        ceo={summary.ceo}
        team={summary.team}
        cycle={cycle}
        prevCycle={prevCycle}
        reviewKey={reviewKey}
        onActiveCycleIdChange={onActiveCycleIdChange}
      />

      <CycleCreateDialog
        ceoId={summary.ceo.id}
        ceoName={summary.ceo.name}
        open={newCycleOpen}
        onOpenChange={setNewCycleOpen}
        onCreated={(id) => onActiveCycleIdChange(id)}
      />
    </div>
  );
}

function CycleBody({
  ceo,
  team,
  cycle,
  prevCycle,
  reviewKey,
  onActiveCycleIdChange,
}: {
  ceo: RosterCeoSummary['ceo'];
  /** Team context from the row's summary. When set, the workspace
   *  surfaces a team strip above the 10x goal callout so the coach
   *  always sees the joint context they're working in. */
  team: RosterCeoSummary['team'];
  cycle: RosterCycle;
  prevCycle: RosterCycle | null;
  reviewKey?: number;
  /** Called when the active cycle changes (e.g. the user just deleted
   *  the current cycle and we need to switch to a sibling). */
  onActiveCycleIdChange: (id: string) => void;
}) {
  const detail = trpc.roster.cycleDetail.useQuery({ cycleId: cycle.id });
  const data = detail.data;

  // Count slots that actually gate readiness for THIS cycle. The KPI
  // slot is conditional — it only counts when `expected=true`, which
  // happens after a prior cycle has logged at least one KPI for this
  // CEO. Otherwise the slot is collapsed (hidden in the UI, ignored
  // here) so the fraction stays meaningful.
  const allSlots = Object.entries(cycle.readiness).filter(([key, slot]) => {
    if (key === 'kpi') return 'expected' in slot && slot.expected;
    return true;
  });
  const totalSlots = allSlots.length;
  const totalReady = allSlots.filter(([, slot]) => slot.done).length;
  const isReady = totalReady === totalSlots;

  const [editCycleOpen, setEditCycleOpen] = useState(false);
  const [pasteTranscriptOpen, setPasteTranscriptOpen] = useState(false);
  const [zoomImportOpen, setZoomImportOpen] = useState(false);
  const [addWeekOpen, setAddWeekOpen] = useState(false);

  // Need the caller's Zoom email to know whether the Zoom import button
  // should be enabled (the dialog itself shows a settings hint when not).
  const me = trpc.coaches.getMe.useQuery();
  const hasZoomEmail = !!me.data?.zoomUserEmail;

  return (
    <div className="grid grid-cols-1 gap-6 px-12 py-5 lg:grid-cols-[1fr_280px]">
      {/* Left column — input slots */}
      <div className="grid gap-3">
        {/* Team context strip — shown when this CEO is part of a team.
            Tells the coach the joint subject of the cycle so they can't
            forget mid-workflow that the report goes to both members
            and the inputs from every member feed it. */}
        {team && <TeamContextStrip team={team} activeCeoId={ceo.id} />}

        {/* 10x goal callout — context for the AI summary, prominent so the
            super admin can see what each CEO is working toward without
            jumping to the profile. */}
        <TenXGoalCallout ceo={ceo} />

        {/* Header row — cycle title is itself a button so it's obvious
            you can edit the cycle (rename, change dates, or delete it)
            from the title. The pencil affordance reinforces the click
            target. */}
        <div className="mb-1 flex items-baseline gap-3">
          <button
            type="button"
            onClick={() => setEditCycleOpen(true)}
            className="group inline-flex items-baseline gap-1.5 rounded text-base font-semibold transition-colors hover:text-foreground/70"
            aria-label="Edit cycle"
          >
            <span>{deriveCycleLabel(cycle)}</span>
            <Pencil className="h-3 w-3 self-center text-muted-foreground/60 transition-colors group-hover:text-foreground" />
          </button>
          <div className="font-mono text-[11px] text-muted-foreground">
            {cycle.periodStart && fmtShortDate(cycle.periodStart)}
            {' → '}
            {cycle.periodEnd && fmtShortDate(cycle.periodEnd)}
            {' · session period for '}
            {ceo.name}
          </div>
          <button
            type="button"
            onClick={() => setEditCycleOpen(true)}
            className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Edit cycle"
          >
            <CalendarRange className="h-3 w-3" /> Edit cycle
          </button>
        </div>

        <CycleEditDialog
          cycle={{
            id: cycle.id,
            label: cycle.label,
            periodStart: cycle.periodStart,
            periodEnd: cycle.periodEnd,
          }}
          open={editCycleOpen}
          onOpenChange={setEditCycleOpen}
          onDeleted={(nextCycleId) => {
            // The deleted cycle was active; switch to a sibling so the
            // workspace doesn't render a not-found state until the
            // cycleSummary cache invalidation re-fetches. If there's no
            // sibling we leave the active id as-is and the workspace
            // null-renders once the parent's cycles array refreshes.
            if (nextCycleId) onActiveCycleIdChange(nextCycleId);
          }}
        />

        {/* Unconfirmed banner */}
        {(data?.unconfirmedCount ?? 0) > 0 && (
          <div
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            style={{
              background: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 92%)',
              borderColor: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 70%)',
              color: 'oklch(58% 0.13 64)',
            }}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {data?.unconfirmedCount} unconfirmed attachment
            {(data?.unconfirmedCount ?? 0) === 1 ? '' : 's'} — confirm or detach before generating
          </div>
        )}

        {detail.isLoading && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading cycle data…
          </div>
        )}

        {/* Inputs supergroup — raw data the AI will read */}
        <SuperGroup
          title="Inputs"
          fraction={`${[cycle.readiness.tx.done, cycle.readiness.weekly.done].filter(Boolean).length}/2`}
        >
        <InputSlot
          title="Zoom Transcript"
          status={cycle.readiness.tx.done ? 'done' : 'empty'}
          summary={
            data?.transcripts[0]
              ? `${data.transcripts[0].zoomMeetingId ? 'Zoom' : 'Manual'}${data.transcripts[0].recordedAt ? ` · ${fmtShortDate(new Date(data.transcripts[0].recordedAt).toISOString().slice(0, 10))}` : ''}${data.transcripts[0].duration ? ` · ${data.transcripts[0].duration} min` : ''} · ${(data.transcripts[0].content ?? '').length.toLocaleString()} chars`
              : undefined
          }
        >
          {data?.transcripts.length ? (
            <>
              {data.transcripts.map((t) => (
                <ExpandableEntry
                  key={t.id}
                  title={t.title || 'Untitled meeting'}
                  sub={`${t.zoomMeetingId ? 'Zoom' : 'Manual'}${t.recordedAt ? ` · ${fmtShortDate(new Date(t.recordedAt).toISOString().slice(0, 10))}` : ''}${t.duration ? ` · ${t.duration} min` : ''}`}
                  dotColor={CONTENT_TYPE_DOT.transcript}
                  content={t.content}
                  meta={`${(t.content ?? '').length.toLocaleString()} chars`}
                />
              ))}
              <div className="flex items-center gap-1 pt-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => setPasteTranscriptOpen(true)}
                >
                  <FilePlus className="mr-1 h-3 w-3" /> Paste another
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => setZoomImportOpen(true)}
                >
                  <Download className="mr-1 h-3 w-3" /> Re-import
                </Button>
              </div>
            </>
          ) : (
            <EmptyHint
              label="No transcript for this session"
              cta={
                <div className="flex items-center gap-1">
                  {/* <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setZoomImportOpen(true)}
                  >
                    <Download className="mr-1 h-3 w-3" /> Import from Zoom
                  </Button> */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setPasteTranscriptOpen(true)}
                  >
                    <FilePlus className="mr-1 h-3 w-3" /> Paste text
                  </Button>
                </div>
              }
            />
          )}
        </InputSlot>

        <ManualTranscriptDialog
          cycleId={cycle.id}
          open={pasteTranscriptOpen}
          onOpenChange={setPasteTranscriptOpen}
        />

        {/* <ZoomImportDialog
          cycleId={cycle.id}
          ceoId={ceo.id}
          hasZoomEmail={hasZoomEmail}
          existingTranscripts={data?.transcripts ?? []}
          open={zoomImportOpen}
          onOpenChange={setZoomImportOpen}
        /> */}

        <InputSlot
          title="Weekly Journals"
          status={
            cycle.readiness.weekly.done
              ? 'done'
              : (data?.journals.length ?? 0) > 0
                ? 'partial'
                : 'empty'
          }
          summary={
            (data?.journals.length ?? 0) > 0
              ? `${data?.journals.length ?? 0} filed`
              : undefined
          }
          countLabel={`${data?.journals.length ?? 0} filed`}
        >
          {data?.journals.length ? (
            <div className="grid gap-1.5">
              {data.journals.map((j) => {
                // Prefer the actual submission timestamp so two journals
                // filed in the same week stay visually distinct. Fall back
                // to the synthetic week range only when the journal has no
                // raw_input ancestor (manually added, etc.).
                const submitted = j.submittedAt
                  ? new Date(j.submittedAt).toISOString().slice(0, 10)
                  : null;
                const title = submitted
                  ? fmtShortDate(submitted)
                  : j.effectiveDate && j.effectiveEndDate && j.effectiveDate !== j.effectiveEndDate
                    ? `${fmtShortDate(j.effectiveDate)} → ${fmtShortDate(j.effectiveEndDate)}`
                    : j.effectiveDate
                      ? fmtShortDate(j.effectiveDate)
                      : `Week ${j.weekNumber}`;
                const borrowed = j.parentCycleId !== cycle.id;
                const parentLabel = deriveCycleLabel({
                  label: j.parentCycleLabel,
                  periodStart: j.parentPeriodStart,
                  periodEnd: j.parentPeriodEnd,
                });
                const sub = borrowed
                  ? `from ${parentLabel} · Week ${j.weekNumber}`
                  : `Week ${j.weekNumber}`;
                return (
                  <ExpandableEntry
                    key={j.id}
                    title={title}
                    sub={sub}
                    dotColor={CONTENT_TYPE_DOT.weekly_journal}
                    content={j.content}
                    compact
                  />
                );
              })}
            </div>
          ) : (
            <EmptyHint label="No weekly journals yet" />
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-1 h-7 w-full border-dashed text-xs text-muted-foreground"
            onClick={() => setAddWeekOpen(true)}
          >
            <Plus className="mr-1 h-3 w-3" />
            Add week
          </Button>
        </InputSlot>

        <AddWeekDialog
          cycleId={cycle.id}
          cyclePeriodStart={cycle.periodStart}
          cyclePeriodEnd={cycle.periodEnd}
          open={addWeekOpen}
          onOpenChange={setAddWeekOpen}
        />

        <InputSlot
          title="Extra Notes & Context"
          status={data?.cycle.additionalContext?.trim() ? 'done' : 'optional'}
          summary={
            data?.cycle.additionalContext?.trim()
              ? `${data.cycle.additionalContext.length.toLocaleString()} chars`
              : undefined
          }
        >
          {data ? (
            <NotesEditor cycleId={cycle.id} initialValue={data.cycle.additionalContext} />
          ) : (
            <div className="px-1 text-[11px] text-muted-foreground">Loading…</div>
          )}
        </InputSlot>
        </SuperGroup>

        {/* Synthesis supergroup — what you concluded for the AI to use */}
        <SuperGroup
          title="Synthesis"
          fraction={`${[cycle.readiness.goals.done, cycle.readiness.reflect.done, cycle.readiness.actions.done].filter(Boolean).length}/3`}
        >

        <InputSlot
          title="Monthly Goals & Commitments"
          status={cycle.readiness.goals.done ? 'done' : 'empty'}
          aiSuggested={cycle.readiness.goals.ai}
          summary={
            cycle.readiness.goals.done && data?.cycle.monthlyGoals
              ? `${data.cycle.monthlyGoals.length.toLocaleString()} chars${cycle.readiness.goals.ai ? ' · AI' : ''}`
              : undefined
          }
        >
          {data ? (
            // Always render the editor — the coach can type goals
            // directly without needing to "AI prefill" first. The
            // editor's footer carries its own Re-generate button so
            // the AI path is still one click away.
            <CycleFieldEditor
              cycleId={cycle.id}
              field="monthlyGoals"
              initialValue={data.cycle.monthlyGoals}
              ai={cycle.readiness.goals.ai}
              rows={6}
              placeholder="Type the monthly goals & commitments — or hit Re-generate to draft from the journals + transcript."
            />
          ) : (
            <div className="px-1 text-[11px] text-muted-foreground">Loading…</div>
          )}
        </InputSlot>

        <InputSlot
          title="Monthly Reflection"
          status={cycle.readiness.reflect.done ? 'done' : 'empty'}
          aiSuggested={cycle.readiness.reflect.ai}
          summary={
            cycle.readiness.reflect.done && data?.cycle.monthlyReflection
              ? `${data.cycle.monthlyReflection.length.toLocaleString()} chars${cycle.readiness.reflect.ai ? ' · AI' : ''}`
              : undefined
          }
        >
          {data ? (
            <CycleFieldEditor
              cycleId={cycle.id}
              field="monthlyReflection"
              initialValue={data.cycle.monthlyReflection}
              ai={cycle.readiness.reflect.ai}
              rows={8}
              placeholder="Type the monthly reflection — or hit Re-generate to draft from the journals + transcript."
            />
          ) : (
            <div className="px-1 text-[11px] text-muted-foreground">Loading…</div>
          )}
        </InputSlot>

        <InputSlot
          title="KPIs / Metrics"
          status={
            (data?.kpis?.filter((k) => k.current?.value).length ?? 0) > 0
              ? 'done'
              : 'optional'
          }
          summary={(() => {
            const filled =
              data?.kpis?.filter((k) => k.current?.value).length ?? 0;
            return filled > 0
              ? `${filled} metric${filled === 1 ? '' : 's'} logged`
              : undefined;
          })()}
        >
          {data ? (
            <CycleKpiEditor
              cycleId={cycle.id}
              ceoId={ceo.id}
              kpis={data.kpis ?? []}
              priorCycleLabel={data.priorCycleLabel ?? null}
            />
          ) : (
            <div className="px-1 text-[11px] text-muted-foreground">Loading…</div>
          )}
        </InputSlot>

        <ActionItemsSlot cycleId={cycle.id} data={data} />
        </SuperGroup>
      </div>

      {/* Right rail */}
      <div className="grid gap-3 self-start">
        <ReadinessCard
          ceoId={ceo.id}
          ceoName={ceo.name}
          cycle={cycle}
          totalReady={totalReady}
          totalSlots={totalSlots}
          isReady={isReady}
          reviewKey={reviewKey}
        />
        {/* "What the AI will see" + Inspect prompt panel removed —
            the inspector renders the v1 single-shot prompt, which now
            only matches the Instant generation mode; for Quick and
            Full the v2 pipeline produces a different prompt entirely.
            The v2 modal has its own "Break out to LLM" affordance
            that's accurate for whichever mode actually ran. Keeping
            the legacy inspector on the workspace was more confusing
            than helpful. */}
        {/* <RecentReports ceoId={ceo.id} ceoName={ceo.name} /> */}
      </div>
    </div>
  );
}

type CycleDetailData = inferRouterOutputs<AppRouter>['roster']['cycleDetail'];

function ActionItemsSlot({
  cycleId,
  data,
}: {
  cycleId: string;
  data: CycleDetailData | undefined;
}) {
  const items = (data?.actionItems ?? []) as Parameters<typeof ActionItemsEditableList>[0]['items'];
  const reviewedCount = data?.actionsBucketed.reviewed ?? 0;
  const total = items.length;
  const isEmpty = total === 0;
  const allReviewed = !isEmpty && reviewedCount === total;
  // Auto-reviewed (zero items) AND fully-reviewed both count as done from
  // a readiness perspective.
  const status: 'done' | 'partial' | 'empty' =
    isEmpty || allReviewed ? 'done' : 'partial';
  const summary = isEmpty
    ? 'auto-reviewed (no items)'
    : `${reviewedCount}/${total} reviewed`;

  return (
    <InputSlot title="Action Items" status={status} summary={summary}>
      <ActionItemsEditableList
        cycleId={cycleId}
        items={items}
        reviewedCount={reviewedCount}
      />
    </InputSlot>
  );
}

/**
 * Re-shaped slot. Drops the per-slot dot (status now lives only in the
 * right-rail readiness checklist + the summary text). When `summary` is
 * present and `status === 'done'`, the slot starts collapsed and shows
 * only its one-liner; click anywhere on the header to expand.
 */
function InputSlot({
  title,
  status,
  summary,
  countLabel,
  children,
  right,
  aiSuggested,
  forceExpanded,
}: {
  title: string;
  status: 'done' | 'empty' | 'partial' | 'optional';
  /** Single-line description shown in the collapsed header (when done). */
  summary?: string;
  countLabel?: string;
  children?: React.ReactNode;
  /** Header-right slot. Only rendered when expanded so it never competes
   *  with the summary text in the collapsed state. */
  right?: React.ReactNode;
  aiSuggested?: boolean;
  /** Override the auto-collapse decision, e.g. when the slot is empty. */
  forceExpanded?: boolean;
}) {
  const collapsible = status === 'done' && !!summary && !forceExpanded;
  const [expanded, setExpanded] = useState(!collapsible);
  const isExpanded = forceExpanded || expanded || !collapsible;

  return (
    <div className="rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => collapsible && setExpanded((e) => !e)}
        disabled={!collapsible}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-2 text-left',
          collapsible && 'cursor-pointer hover:bg-muted/40'
        )}
        aria-expanded={isExpanded}
      >
        {collapsible ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <div className="text-[13px] font-medium">{title}</div>
        {aiSuggested && <AiBadge />}
        <span className="flex-1" />
        {!isExpanded && summary && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        {isExpanded && countLabel && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {countLabel}
          </span>
        )}
        {isExpanded && right && (
          <div
            className="flex items-center gap-1"
            // Stop the inner buttons from collapsing the slot when clicked.
            onClick={(e) => e.stopPropagation()}
          >
            {right}
          </div>
        )}
      </button>
      {isExpanded && (
        <div className="grid gap-1.5 border-t border-border/60 px-3 py-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

function SuperGroup({
  title,
  fraction,
  children,
}: {
  title: string;
  fraction: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline gap-2 px-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {fraction}
        </span>
      </div>
      <div className="grid gap-2">{children}</div>
    </section>
  );
}

function AiBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        background: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 88%)',
        color: 'oklch(58% 0.14 258)',
        border: '1px solid color-mix(in oklab, oklch(58% 0.14 258), transparent 70%)',
      }}
    >
      <Sparkles className="h-2.5 w-2.5" /> AI suggested
    </span>
  );
}

/** Strip rendered at the top of the cycle workspace when the active CEO
 *  is in a coaching team. Reminds the coach the report is joint and
 *  surfaces every member's avatar so it's obvious who's contributing
 *  inputs to this cycle. */
function TeamContextStrip({
  team,
  activeCeoId,
}: {
  team: NonNullable<RosterCeoSummary['team']>;
  activeCeoId: string;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-md border px-3 py-2"
      style={{
        borderColor: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 60%)',
        background: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 92%)',
      }}
    >
      <div className="flex shrink-0 -space-x-2">
        {team.members.map((m) => (
          <span
            key={m.id}
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-full ring-2',
              m.id === activeCeoId ? 'ring-foreground/30' : 'ring-background',
            )}
            style={{ background: 'var(--muted)' }}
            title={`${m.name}${m.memberRole ? ` — ${m.memberRole}` : ''}`}
          >
            <CeoAvatar name={m.name} avatarUrl={m.avatarUrl} size="sm" />
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-[oklch(58%_0.14_258)]">
          Coaching team · {team.members.length} members
        </p>
        <p className="truncate text-[13px] font-medium">
          {team.name}
          {team.companyName && team.companyName !== team.name ? (
            <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">
              ({team.companyName})
            </span>
          ) : null}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {team.members
            .map((m) => `${m.name}${m.memberRole ? ` · ${m.memberRole}` : ''}`)
            .join(' — ')}
        </p>
      </div>
      <p
        className="hidden shrink-0 text-right text-[10.5px] leading-snug text-muted-foreground/80 sm:block"
        style={{ maxWidth: 160 }}
      >
        Inputs from every member feed this cycle. The report is one joint
        document.
      </p>
    </div>
  );
}

function TenXGoalCallout({
  ceo,
}: {
  ceo: { id: string; name: string; email: string | null; tenXGoal: string | null };
}) {
  const has = !!ceo.tenXGoal?.trim();
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  return (
    <>
      <div
        className="rounded-lg border px-3 py-2.5"
        style={
          has
            ? {
                background: 'color-mix(in oklab, oklch(55% 0.12 152), transparent 94%)',
                borderColor: 'color-mix(in oklab, oklch(55% 0.12 152), transparent 65%)',
              }
            : { background: 'var(--muted)', borderColor: 'var(--border)' }
        }
      >
        <div className="mb-1 flex items-center gap-1.5">
          <Target
            className="h-3 w-3"
            style={{ color: has ? 'oklch(55% 0.12 152)' : 'var(--muted-foreground)' }}
          />
          <span
            className="font-mono text-[10px] uppercase tracking-wider"
            style={{ color: has ? 'oklch(55% 0.12 152)' : 'var(--muted-foreground)' }}
          >
            {ceo.name}&apos;s 10x goal
          </span>
          <span className="flex-1" />
          {has && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="inline-flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
              aria-expanded={expanded}
            >
              {expanded ? (
                <>
                  collapse <ChevronDown className="h-3 w-3" />
                </>
              ) : (
                <>
                  expand <ChevronRight className="h-3 w-3" />
                </>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            edit
          </button>
        </div>
        {has ? (
          expanded ? (
            <div className="max-h-40 overflow-y-auto pr-1">
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
                {ceo.tenXGoal}
              </p>
            </div>
          ) : (
            <p
              className="text-[12.5px] leading-relaxed text-foreground/90"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {ceo.tenXGoal}
            </p>
          )
        ) : (
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="text-left text-[12px] italic text-muted-foreground hover:text-foreground hover:underline"
          >
            No 10x goal set — click to capture one.
          </button>
        )}
      </div>
      <RosterEditCeoDialog ceo={ceo} open={editOpen} onOpenChange={setEditOpen} />
    </>
  );
}

function ExpandableEntry({
  title,
  sub,
  dotColor,
  content,
  meta,
  compact,
}: {
  title: string;
  sub?: string;
  dotColor: string;
  content: string | null;
  meta?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasContent = !!content?.trim();
  return (
    <div className="overflow-hidden rounded border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => hasContent && setOpen((o) => !o)}
        disabled={!hasContent}
        className={cn(
          'flex w-full items-center gap-2.5 text-left transition-colors',
          compact ? 'px-2.5 py-1.5' : 'px-2.5 py-2',
          hasContent && 'hover:bg-muted/50'
        )}
      >
        <span
          className="grid h-3 w-3 shrink-0 place-items-center text-muted-foreground"
          aria-hidden
        >
          {hasContent ? (
            open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : null}
        </span>
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: dotColor }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px]">{title}</div>
          {!compact && sub && (
            <div className="truncate font-mono text-[11px] text-muted-foreground">{sub}</div>
          )}
        </div>
        {meta && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{meta}</span>
        )}
      </button>
      {open && hasContent && (
        <div className="max-h-72 overflow-y-auto border-t border-border bg-background px-3 py-2.5">
          <pre className="whitespace-pre-wrap break-words font-sans text-[11.5px] leading-relaxed text-foreground/85">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

function EmptyHint({ label, cta }: { label: string; cta?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded border border-dashed border-border bg-muted/20 px-2.5 py-2">
      <span className="flex-1 text-[12px] italic text-muted-foreground">{label}</span>
      {cta}
    </div>
  );
}

/**
 * Inline AI prefill trigger for an empty Monthly Goals / Monthly Reflection
 * slot. Calls roster.prefillCycleField — on success the cycle data is
 * invalidated and the slot re-renders with CycleFieldEditor showing the
 * AI-suggested value (with Undo + Re-generate already wired up there).
 */
function PrefillButton({
  cycleId,
  field,
  label,
}: {
  cycleId: string;
  field: 'monthlyGoals' | 'monthlyReflection';
  label: string;
}) {
  const utils = trpc.useUtils();
  const prefill = trpc.roster.prefillCycleField.useMutation({
    onSuccess: () => {
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
    },
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px]"
        disabled={prefill.isPending}
        onClick={() => prefill.mutate({ cycleId, field })}
      >
        {prefill.isPending ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="mr-1 h-3 w-3" />
        )}
        {prefill.isPending ? 'Generating…' : label}
      </Button>
      {prefill.error && (
        <span className="text-[10px] text-destructive">{prefill.error.message}</span>
      )}
    </div>
  );
}

function BodyText({ children, ai }: { children: React.ReactNode; ai?: boolean }) {
  return (
    <div
      className={cn(
        'whitespace-pre-wrap rounded border px-3 py-2.5 text-[12px] leading-relaxed text-foreground/85'
      )}
      style={
        ai
          ? {
              background: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 95%)',
              borderColor: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 75%)',
            }
          : { background: 'var(--muted)', borderColor: 'var(--border)' }
      }
    >
      {children}
    </div>
  );
}

/** Short, human-readable label for a v2 generation job's current
 *  stage. Used inline next to the "View generation" button while the
 *  pipeline is running. */
function jobStageLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Queued';
    case 'extracting_facts':
      return 'Reading inputs';
    case 'matching_patterns':
      return 'Comparing cycles';
    case 'drafting_first':
      return 'Drafting';
    case 'critiquing':
      return 'Reviewing';
    case 'revising':
      return 'Polishing';
    case 'finalising':
      return 'Finalising';
    default:
      return status;
  }
}

/** Inline plain-language explainer for the three generation modes.
 *  Collapses by default; click to expand. Lives directly under the
 *  three Generate buttons so a coach who's unsure which to click can
 *  read about them without leaving the page or hunting through docs. */
function GenerationModeExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span>What&apos;s the difference between these?</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-border bg-muted/20 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">
              Instant (~50s).
            </span>{' '}
            The AI writes a draft straight from the inputs. Fastest, but it
            won&apos;t cite specific quotes or compare to prior cycles. Best
            when you&apos;re short on time and plan to edit heavily yourself.
          </p>
          <p>
            <span className="font-semibold text-foreground">
              Quick (~5 min) — recommended.
            </span>{' '}
            The AI first extracts the named stakeholders, KPIs, commitments
            and emotional moments from the inputs (with citations back to
            the source), looks at how this month compares to prior cycles,
            and then writes the draft. Good balance of speed and grounding.
          </p>
          <p>
            <span className="font-semibold text-foreground">
              Full polish (~15 min).
            </span>{' '}
            Everything Quick does, plus the AI reviews its own draft against
            a 9-point quality rubric and rewrites any weak sections (up to
            two revision passes). Highest quality, longest wait.
          </p>
          <p className="pt-1 text-muted-foreground/80">
            All three modes will generate even when inputs are missing —
            Quick and Full will explicitly flag the gaps in the report;
            Instant just produces thinner prose in those spots.
          </p>
        </div>
      )}
    </div>
  );
}

function ReadinessCard({
  ceoId,
  ceoName,
  cycle,
  totalReady,
  totalSlots,
  isReady,
  reviewKey,
}: {
  ceoId: string;
  ceoName: string;
  cycle: RosterCycle;
  totalReady: number;
  totalSlots: number;
  isReady: boolean;
  reviewKey?: number;
}) {
  const utils = trpc.useUtils();
  const [confirmGapsOpen, setConfirmGapsOpen] = useState(false);
  const [pendingTriageOpen, setPendingTriageOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Collapsible inputs checklist. Default open when the cycle is fully
  // ready (a clean checklist confirms readiness at a glance) and closed
  // otherwise so the coach's eye goes to the missing-inputs callout +
  // generate buttons below without scrolling past 6 individual rows.
  const [checklistOpen, setChecklistOpen] = useState(false);
  // Captured when the coach clicks any generate button while inputs
  // have gaps OR there are pending triage items, so the corresponding
  // dialog knows which mode to fire on confirm.
  const [pendingMode, setPendingMode] = useState<'instant' | 'quick' | 'full'>('quick');

  // Untriaged content the matcher *thinks* might belong to this CEO.
  // Queried unconditionally so the readiness card can show the warning
  // chip even before the coach considers generating; the modal reuses
  // the same query (cached by ceoId) so opening it doesn't double-fetch.
  const pendingTriage = trpc.inbox.pendingForCeo.useQuery({ ceoId });
  const pendingTriageCount = pendingTriage.data?.total ?? 0;

  // Detect a v2 generation already in flight for THIS cycle. Reuses
  // the global listActiveJobs query the row + corner pill already poll
  // — same cache key, so no duplicate network traffic. While a job is
  // live, the per-phase generate / review buttons collapse to a single
  // "View generation" button that opens the modal in its GeneratingScreen
  // state. Prevents a coach from kicking off a duplicate run by re-
  // clicking Generate while the prior one is still polishing.
  const activeJobs = trpc.reports.listActiveJobs.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data && q.state.data.length > 0 ? 2000 : false),
    refetchIntervalInBackground: false,
  });
  const liveJob = (activeJobs.data ?? []).find((j) => j.cycleId === cycle.id);

  // Auto-open the report reviewer when the parent row's "Review →" button
  // is clicked. The row bumps `reviewKey` each time so consecutive clicks
  // re-open the dialog after the user has dismissed it. Opens whenever
  // there's something to look at — a finished report (generated/sent) OR
  // a generation in flight (modal will show its GeneratingScreen state).
  useEffect(() => {
    if (reviewKey === undefined || reviewKey === 0) return;
    if (cycle.phase === 'generated' || cycle.phase === 'sent' || liveJob) {
      setReviewOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewKey]);
  // Fire the v2 async job so the user sees the same pipeline progress
  // bar that regenerate uses. The mutation returns ~immediately with a
  // jobId; we open the report modal at the same time so its built-in
  // GeneratingScreen polls getActiveJob and renders the live stage
  // strip. Roster / cycle invalidations fire once the job completes
  // (handled by the modal's onJobComplete logic).
  const generate = trpc.reports.generateV2.useMutation({
    onSuccess: async () => {
      // Invalidate BOTH the per-cycle active-job query (drives the
      // modal's progress screen) AND the roster-wide listActiveJobs
      // query (drives every row's "Generating" pill). The row polling
      // is gated on `data.length > 0`, so without this invalidate a
      // freshly-started job from a state of zero active jobs would be
      // invisible at the row level until the next page-level refresh.
      await Promise.all([
        utils.reports.getActiveJob.invalidate({ cycleId: cycle.id }),
        utils.reports.listActiveJobs.invalidate(),
      ]);
      setConfirmGapsOpen(false);
      setReviewOpen(true);
    },
  });
  // Shared entry point for the three generate buttons. Routes through
  // two guard rails in priority order:
  //   1. If the matcher has un-triaged content that *might* be this
  //      CEO's, surface the PendingTriageDialog first — coach can
  //      confirm or dismiss before generating.
  //   2. Otherwise, if the cycle still has missing required inputs,
  //      surface the existing ConfirmGapsDialog (same flow as before).
  //   3. Otherwise fire the mutation straight away.
  function attemptGenerate(mode: 'instant' | 'quick' | 'full') {
    setPendingMode(mode);
    if (pendingTriageCount > 0) {
      setPendingTriageOpen(true);
      return;
    }
    if (!isReady) {
      setConfirmGapsOpen(true);
      return;
    }
    generate.mutate({ cycleId: cycle.id, mode });
  }

  // Order mirrors the left-hand form's top-to-bottom flow so the
  // operator's eye sweeps the same sequence on both columns: the 10x
  // banner is at the top of the page, then Inputs (transcript +
  // weekly journals + KPIs when expected), then Synthesis (monthly
  // goals + reflection), then Action Items.
  //
  // KPIs are *adaptive*: the slot is hidden entirely when no prior
  // cycle for this CEO has logged any. Once a cycle has logged KPIs
  // even once, all later cycles surface the slot as a gate.
  const allItems: Array<{
    key: keyof RosterCycle['readiness'];
    label: string;
    conditional?: boolean;
  }> = [
    { key: 'tenx', label: '10x goal' },
    { key: 'tx', label: 'Zoom transcript' },
    { key: 'weekly', label: 'Weekly journals (≥3)' },
    { key: 'kpi', label: 'KPIs', conditional: true },
    { key: 'goals', label: 'Monthly goals' },
    { key: 'reflect', label: 'Monthly reflection' },
    { key: 'actions', label: 'Action items reviewed' },
  ];

  const items = allItems.filter((i) => {
    if (!i.conditional) return true;
    const slot = cycle.readiness[i.key];
    return 'expected' in slot && slot.expected;
  });

  const missingLabels = items
    .filter((i) => !cycle.readiness[i.key].done)
    .map((i) => i.label);
  return (
    <div
      className="rounded-lg border p-3.5"
      style={
        isReady
          ? {
              background: 'color-mix(in oklab, oklch(55% 0.12 152), transparent 92%)',
              borderColor: 'color-mix(in oklab, oklch(55% 0.12 152), transparent 60%)',
            }
          : { background: 'var(--background)', borderColor: 'var(--border)' }
      }
    >
      {/* Collapsible inputs checklist. The header bar always shows the
          status ("3 of 6 inputs ready"); the per-item list expands
          only when the coach wants to drill in. Default open when
          isReady so a fully-prepped cycle still confirms what's in;
          default closed otherwise to keep the card scannable when
          the coach is mid-workflow. */}
      <button
        type="button"
        onClick={() => setChecklistOpen((v) => !v)}
        className={cn(
          'mb-2.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/40',
          isReady && 'text-[oklch(55%_0.12_152)]',
        )}
        aria-expanded={checklistOpen}
        aria-controls={`readiness-list-${cycle.id}`}
      >
        <span
          className="grid h-5 w-5 place-items-center rounded text-[12px] text-white"
          style={{
            background: isReady ? 'oklch(55% 0.12 152)' : 'var(--muted)',
            color: isReady ? 'white' : 'var(--muted-foreground)',
          }}
        >
          {isReady ? '✓' : ' '}
        </span>
        <div className="flex-1 text-[13px] font-semibold">
          {isReady ? 'All inputs complete' : `${totalReady} of ${totalSlots} inputs ready`}
        </div>
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            checklistOpen && 'rotate-90',
          )}
        />
      </button>
      {checklistOpen && (
        <div id={`readiness-list-${cycle.id}`} className="mb-3 grid gap-1 pl-1.5">
          {items.map((i) => {
            const r = cycle.readiness[i.key];
            return (
              <div key={i.key} className="flex items-center gap-2 text-[12px]">
                <span
                  className="grid h-3 w-3 place-items-center rounded-sm text-[8px] text-white"
                  style={{
                    background: r.done
                      ? r.ai
                        ? 'color-mix(in oklab, oklch(58% 0.14 258), transparent 50%)'
                        : 'oklch(55% 0.12 152)'
                      : 'transparent',
                    border: r.done ? 'none' : '1px solid var(--border)',
                  }}
                >
                  {r.done ? '✓' : ''}
                </span>
                <span className={cn(r.done ? 'text-foreground/85' : 'text-muted-foreground')}>{i.label}</span>
                {r.ai && (
                  <span className="ml-1 rounded bg-[oklch(58%_0.14_258)/15] px-1 py-px text-[9px] font-medium text-[oklch(58%_0.14_258)]">
                    AI
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="grid gap-1.5">
        {liveJob && (
          <>
            <Button
              size="sm"
              className="h-7 text-xs"
              style={{ background: 'oklch(58% 0.14 258)' }}
              onClick={() => setReviewOpen(true)}
              title={`Open the live generation for ${cycle.label}.`}
            >
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              View generation
            </Button>
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              {jobStageLabel(liveJob.status)} · waiting for the pipeline to
              finish before you can re-generate.
            </p>
          </>
        )}
        {!liveJob && cycle.phase === 'sent' && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setReviewOpen(true)}
          >
            View sent report
          </Button>
        )}
        {!liveJob && cycle.phase === 'generated' && (
          <Button
            size="sm"
            className="h-7 text-xs"
            style={{ background: 'oklch(58% 0.14 258)' }}
            onClick={() => setReviewOpen(true)}
          >
            Review report
          </Button>
        )}
        {!liveJob && (cycle.phase === 'ready' || cycle.phase === 'gathering') && (
          <>
            {/* Three-mode generate.
                  Instant — single-shot legacy generator (~50s).
                  Quick   — facts + patterns + draft, no rubric (~5 min).
                  Full    — adds rubric self-check + revisions (~15 min).
                Buttons share visual weight; the only state-driven cue
                is the "missing inputs" chip below. Quick stays the
                highlighted/primary option as the recommended balance
                of speed and quality. */}
            {pendingTriageCount > 0 && (
              <button
                type="button"
                onClick={() => setPendingTriageOpen(true)}
                className="mb-0.5 flex items-center gap-1.5 rounded text-left text-[11px] hover:underline"
                style={{ color: 'oklch(58% 0.13 64)' }}
                title="The AI thinks there might be more inputs in the inbox for this CEO. Review before generating."
              >
                <AlertTriangle className="h-3 w-3 shrink-0" />
                <span>
                  {pendingTriageCount} item{pendingTriageCount === 1 ? '' : 's'} in
                  inbox might be {ceoName.split(' ')[0]}&apos;s
                  <span className="ml-1 text-muted-foreground">→ review</span>
                </span>
              </button>
            )}

            {/* Section header — anchors the buttons as "this is the
                generate panel", not a continuation of the checklist. */}
            <div className="mb-1 mt-1 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Generate report
              </span>
              <div className="h-px flex-1 bg-border/60" />
            </div>

            {/* Combined missing-inputs + reassurance card. Replaces the
                separate amber warning and the ghost "Heads-up" line at
                the bottom — both said similar things in different
                places. One block, clear: what's missing, and the
                explicit promise that generation still works. */}
            {!isReady && (
              <div
                className="mb-1 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed"
                style={{
                  borderColor:
                    'color-mix(in oklab, oklch(58% 0.13 64), transparent 65%)',
                  background:
                    'color-mix(in oklab, oklch(58% 0.13 64), transparent 92%)',
                }}
              >
                <div
                  className="flex items-start gap-1.5"
                  style={{ color: 'oklch(58% 0.13 64)' }}
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    <span className="font-medium">
                      Missing {missingLabels.length === 1 ? 'input' : 'inputs'}:
                    </span>{' '}
                    {missingLabels.slice(0, 3).join(', ')}
                    {missingLabels.length > 3 ? ` +${missingLabels.length - 3}` : ''}
                  </span>
                </div>
                <p className="ml-4.5 mt-1 text-muted-foreground">
                  You can still generate — the report will use what&apos;s
                  there and flag what isn&apos;t.
                </p>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={generate.isPending}
              onClick={() => attemptGenerate('instant')}
              title="Fastest option. The AI writes a draft directly from the inputs without first extracting structured facts. Good when you're short on time and plan to edit heavily yourself."
            >
              {generate.isPending ? (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              ) : (
                <Zap className="mr-1.5 h-3 w-3" />
              )}
              Instant (~50s)
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={generate.isPending}
              style={{ background: 'oklch(58% 0.14 258)' }}
              onClick={() => attemptGenerate('quick')}
              title="Recommended default. The AI reads every input, extracts the named stakeholders, KPIs, commitments and emotional events with citations back to the source, looks at how this month compares to prior cycles, then writes the draft."
            >
              {generate.isPending ? (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              ) : (
                <Mail className="mr-1.5 h-3 w-3" />
              )}
              {generate.isPending ? 'Generating…' : 'Quick (~5 min)'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={generate.isPending}
              onClick={() => attemptGenerate('full')}
              title="Everything Quick does, plus the AI reviews its own draft against a 9-point quality rubric and rewrites any weak sections (up to 2 passes). Highest-quality output, longest wait."
            >
              <Sparkles className="mr-1.5 h-3 w-3" />
              Full polish (~15 min)
            </Button>
            {/* Plain-language explainer the coach can expand inline. Keeps
                the buttons themselves uncluttered while still answering
                "what's the difference?" without leaving the page. The
                "you can still generate with gaps" reassurance moved up
                into the missing-inputs card above so it's adjacent to
                the warning it's softening. */}
            <GenerationModeExplainer />
            {generate.error && (
              <p className="mt-1 text-[11px] text-destructive">
                {generate.error.message}
              </p>
            )}
            <ConfirmGapsDialog
              open={confirmGapsOpen}
              onOpenChange={setConfirmGapsOpen}
              ceoName={ceoName}
              cycleLabel={cycle.label}
              missing={missingLabels}
              mode={pendingMode}
              isPending={generate.isPending}
              onConfirm={() =>
                generate.mutate({ cycleId: cycle.id, mode: pendingMode })
              }
            />
            <PendingTriageDialog
              open={pendingTriageOpen}
              onOpenChange={setPendingTriageOpen}
              ceoId={ceoId}
              ceoName={ceoName}
              mode={pendingMode}
              isReadyToGenerate={isReady}
              isGeneratePending={generate.isPending}
              onProceedAfterTriage={() =>
                generate.mutate({ cycleId: cycle.id, mode: pendingMode })
              }
              onProceedAcceptingGaps={() => setConfirmGapsOpen(true)}
            />
          </>
        )}
        <ReportDocumentModal
          cycleId={cycle.id}
          ceoName={ceoName}
          cycleLabel={cycle.label}
          periodStart={cycle.periodStart}
          periodEnd={cycle.periodEnd}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
        />
        {!liveJob && cycle.phase === 'idle' && (
          <Button variant="ghost" size="sm" className="h-7 text-xs">
            Send nudge
          </Button>
        )}
      </div>
    </div>
  );
}

function ConfirmGapsDialog({
  open,
  onOpenChange,
  ceoName,
  cycleLabel,
  missing,
  mode,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ceoName: string;
  cycleLabel: string;
  missing: string[];
  mode: 'instant' | 'quick' | 'full';
  isPending: boolean;
  onConfirm: () => void;
}) {
  // Quick/Full extract typed facts (Stage A) before drafting, so the
  // model knows which fields were empty and can flag them in the email
  // body. Instant skips that step — it just calls the legacy prompt
  // with raw inputs, and the missing pieces become "subtly thin prose
  // with no signal". Worth an extra warning so the coach knows the
  // consequence of picking Instant + gaps is materially different.
  const isInstant = mode === 'instant';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Generate with gaps?
          </DialogTitle>
          <DialogDescription className="pt-1">
            {ceoName} · {cycleLabel} —{' '}
            <span className="font-medium text-foreground">
              {missing.length}
            </span>{' '}
            input{missing.length === 1 ? '' : 's'} aren&apos;t filled in yet.
            {isInstant ? (
              <>
                {' '}
                <span className="font-medium text-foreground">
                  Instant mode skips fact extraction
                </span>
                , so the model has no way to flag what was missing — gaps
                will surface as thinner prose rather than an explicit
                callout. Use Quick or Full if you want the missing pieces
                named in the email.
              </>
            ) : (
              <>
                {' '}
                The AI will use what&apos;s there and flag the missing
                pieces in the email.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="mt-2 space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          {missing.map((m) => (
            <li
              key={m}
              className="flex items-center gap-2 text-amber-700 dark:text-amber-400"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              {m}
            </li>
          ))}
        </ul>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={isPending}
            onClick={onConfirm}
            style={{ background: 'oklch(58% 0.13 64)' }}
          >
            {isPending ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <Mail className="mr-1.5 h-3 w-3" />
            )}
            Generate anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pre-generation triage guard rail.
 *
 * Surfaces every raw_input the matcher *suspects* belongs to this CEO
 * but hasn't fully resolved yet — so the coach can confirm or dismiss
 * them inline before kicking off a report that would otherwise miss
 * potentially important context.
 *
 * Three confidence buckets:
 *   • highConfidence — AI's primary guess + match ≥ 85. Auto-checked
 *     so the bulk "Confirm all" action is one click.
 *   • lowConfidence  — AI's primary guess but < 85. Surfaced separately
 *     so the coach must read each before confirming.
 *   • alternative    — this CEO is a runner-up; the AI's top pick was
 *     someone else. Lowest urgency.
 *   • pendingCycle   — matched to this CEO but couldn't resolve a
 *     cycle. Rare with the strict matcher.
 *
 * "Generate now" closes the dialog and re-enters the generate flow —
 * if there are still input gaps, it chains into ConfirmGapsDialog.
 */
function PendingTriageDialog({
  open,
  onOpenChange,
  ceoId,
  ceoName,
  mode,
  isReadyToGenerate,
  isGeneratePending,
  onProceedAfterTriage,
  onProceedAcceptingGaps,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ceoId: string;
  ceoName: string;
  mode: 'instant' | 'quick' | 'full';
  /** Whether the cycle has all required inputs after potential confirms. */
  isReadyToGenerate: boolean;
  /** Generate mutation pending — disables the "Generate now" CTA. */
  isGeneratePending: boolean;
  /** Called when the coach clicks "Generate now" and inputs are ready. */
  onProceedAfterTriage: () => void;
  /** Called when the coach clicks "Generate anyway" with gaps still present.
   *  ReadinessCard chains this to the ConfirmGapsDialog. */
  onProceedAcceptingGaps: () => void;
}) {
  const utils = trpc.useUtils();
  const isInstant = mode === 'instant';

  const pending = trpc.inbox.pendingForCeo.useQuery(
    { ceoId },
    { enabled: open },
  );

  // Per-row pending flags so we can disable individual buttons while their
  // mutation is in flight without blocking siblings.
  const [busyRowIds, setBusyRowIds] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);

  // After any triage action: invalidate the dialog's own query (so the
  // row disappears), the per-cycle readiness / summary (a confirmed
  // input may flip a readiness slot to green), the admin inbox listing,
  // and the roster-wide pending-counts batch (so row badges update).
  async function invalidateAll() {
    await Promise.all([
      utils.inbox.pendingForCeo.invalidate({ ceoId }),
      utils.inbox.triagePendingCounts.invalidate(),
      utils.roster.cycleDetail.invalidate(),
      utils.roster.cycleSummary.invalidate(),
      utils.inbox.listPending.invalidate(),
    ]);
  }

  const confirmOne = trpc.inbox.confirmPendingForCeo.useMutation({
    onSuccess: invalidateAll,
  });
  const dismissOne = trpc.inbox.dismissPendingForCeo.useMutation({
    onSuccess: invalidateAll,
  });
  const bulkConfirm = trpc.inbox.bulkConfirmPendingForCeo.useMutation({
    onSuccess: invalidateAll,
  });

  async function handleConfirm(rawInputId: string) {
    setBusyRowIds((s) => ({ ...s, [rawInputId]: true }));
    try {
      await confirmOne.mutateAsync({ rawInputId, ceoId });
    } finally {
      setBusyRowIds((s) => {
        const next = { ...s };
        delete next[rawInputId];
        return next;
      });
    }
  }
  async function handleDismiss(rawInputId: string) {
    setBusyRowIds((s) => ({ ...s, [rawInputId]: true }));
    try {
      await dismissOne.mutateAsync({ rawInputId, ceoId });
    } finally {
      setBusyRowIds((s) => {
        const next = { ...s };
        delete next[rawInputId];
        return next;
      });
    }
  }
  async function handleBulkConfirmHigh() {
    const ids = (pending.data?.highConfidence ?? []).map((i) => i.rawInputId);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await bulkConfirm.mutateAsync({ rawInputIds: ids, ceoId });
    } finally {
      setBulkBusy(false);
    }
  }

  const total = pending.data?.total ?? 0;
  const remaining = total; // refetches keep this in sync

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Before you generate
          </DialogTitle>
          <DialogDescription className="pt-1">
            The AI thinks{' '}
            <span className="font-medium text-foreground">{remaining}</span>{' '}
            item{remaining === 1 ? '' : 's'} in the inbox might be{' '}
            <span className="font-medium text-foreground">{ceoName}</span>&apos;s.
            Confirm or dismiss each below, then generate.
          </DialogDescription>
        </DialogHeader>

        {isInstant && (
          <div
            className="mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[11.5px] leading-snug"
            style={{
              background: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 92%)',
              borderColor: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 60%)',
              color: 'oklch(45% 0.12 64)',
            }}
          >
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            <span>
              <span className="font-medium">Instant mode skips fact extraction</span>,
              so anything you leave un-triaged here just won&apos;t exist in
              the report — there&apos;s no stage that can flag it as
              missing. Quick or Full would at least surface a callout.
            </span>
          </div>
        )}

        {pending.isLoading && (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking the inbox…
          </div>
        )}

        {!pending.isLoading && total === 0 && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-4 text-xs text-emerald-700 dark:text-emerald-400">
            All clear — nothing else looks like it belongs to {ceoName}.
            You&apos;re good to generate.
          </div>
        )}

        <div className="mt-3 space-y-4">
          {(pending.data?.highConfidence?.length ?? 0) > 0 && (
            <TriageBucket
              label="High confidence"
              hint="The AI is fairly sure these are this CEO's. Bulk-confirm if they look right."
              tone="strong"
              items={pending.data!.highConfidence}
              busyRowIds={busyRowIds}
              onConfirm={handleConfirm}
              onDismiss={handleDismiss}
              bulkAction={
                <Button
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={bulkBusy}
                  onClick={handleBulkConfirmHigh}
                  style={{ background: 'oklch(55% 0.12 152)' }}
                >
                  {bulkBusy ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : null}
                  Confirm all {pending.data!.highConfidence.length}
                </Button>
              }
            />
          )}
          {(pending.data?.lowConfidence?.length ?? 0) > 0 && (
            <TriageBucket
              label="Possibly this CEO (low confidence)"
              hint="The AI's top guess was this CEO but it isn't sure. Read each before confirming."
              tone="weak"
              items={pending.data!.lowConfidence}
              busyRowIds={busyRowIds}
              onConfirm={handleConfirm}
              onDismiss={handleDismiss}
            />
          )}
          {(pending.data?.alternative?.length ?? 0) > 0 && (
            <TriageBucket
              label="Listed as a runner-up"
              hint="The AI matched these to a different CEO but flagged this CEO as a possible alternative."
              tone="weak"
              items={pending.data!.alternative}
              busyRowIds={busyRowIds}
              onConfirm={handleConfirm}
              onDismiss={handleDismiss}
            />
          )}
          {(pending.data?.pendingCycle?.length ?? 0) > 0 && (
            <TriageBucket
              label="Matched but cycle unresolved"
              hint="Already linked to this CEO; needs a cycle. Confirm to attach to the closest cycle."
              tone="weak"
              items={pending.data!.pendingCycle}
              busyRowIds={busyRowIds}
              onConfirm={handleConfirm}
              onDismiss={handleDismiss}
            />
          )}
        </div>

        <DialogFooter className="mt-5 flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            {total > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  if (isReadyToGenerate) onProceedAfterTriage();
                  else onProceedAcceptingGaps();
                }}
                title="Skip the remaining items and start the report anyway."
              >
                Skip &amp; generate anyway
              </Button>
            )}
            <Button
              disabled={isGeneratePending}
              onClick={() => {
                onOpenChange(false);
                if (isReadyToGenerate) onProceedAfterTriage();
                else onProceedAcceptingGaps();
              }}
              style={{ background: 'oklch(58% 0.14 258)' }}
            >
              {isGeneratePending ? (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              ) : (
                <Mail className="mr-1.5 h-3 w-3" />
              )}
              {total === 0 ? 'Generate now' : 'Generate'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One confidence-grouped section of the PendingTriageDialog. */
function TriageBucket({
  label,
  hint,
  tone,
  items,
  busyRowIds,
  onConfirm,
  onDismiss,
  bulkAction,
}: {
  label: string;
  hint: string;
  tone: 'strong' | 'weak';
  items: Array<{
    rawInputId: string;
    contentType: string;
    occurredAt: Date | string;
    suggestedReason: string | null;
    matchConfidence: number | null;
    textPreview: string;
  }>;
  busyRowIds: Record<string, boolean>;
  onConfirm: (rawInputId: string) => void;
  onDismiss: (rawInputId: string) => void;
  bulkAction?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div>
          <div
            className={cn(
              'text-[11px] font-semibold uppercase tracking-wide',
              tone === 'strong' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
            )}
          >
            {label}
          </div>
          <div className="text-[10.5px] text-muted-foreground">{hint}</div>
        </div>
        {bulkAction}
      </div>
      <div className="space-y-2">
        {items.map((item) => {
          const busy = !!busyRowIds[item.rawInputId];
          return (
            <div
              key={item.rawInputId}
              className="rounded-md border bg-card p-2.5"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium uppercase tracking-wide">
                      {item.contentType.replace(/_/g, ' ')}
                    </span>
                    <span>·</span>
                    <span>
                      {fmtShortDate(
                        item.occurredAt instanceof Date
                          ? item.occurredAt.toISOString()
                          : item.occurredAt,
                      )}
                    </span>
                    {item.matchConfidence != null && (
                      <>
                        <span>·</span>
                        <span
                          className="rounded px-1 py-px font-mono text-[10px]"
                          style={{
                            background: 'color-mix(in oklab, oklch(58% 0.14 258), transparent 88%)',
                            color: 'oklch(58% 0.14 258)',
                          }}
                        >
                          {item.matchConfidence}%
                        </span>
                      </>
                    )}
                  </div>
                  {item.suggestedReason && (
                    <div className="mt-0.5 text-[11px] italic text-muted-foreground">
                      {item.suggestedReason}
                    </div>
                  )}
                  {item.textPreview && (
                    <div className="mt-1 line-clamp-2 text-[12px] text-foreground/85">
                      {item.textPreview}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={() => onDismiss(item.rawInputId)}
                    title="Remove this CEO from the AI's suggestions for this item."
                  >
                    Not theirs
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={() => onConfirm(item.rawInputId)}
                    style={{ background: 'oklch(55% 0.12 152)' }}
                  >
                    {busy ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : null}
                    Confirm
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ContextInspector({
  ceoName,
  cycle,
  prevCycle,
  submissionsCount,
}: {
  ceoId: string;
  ceoName: string;
  cycle: RosterCycle;
  prevCycle: RosterCycle | null;
  submissionsCount: number;
}) {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const rows: Array<{ label: string; detail: string; dim?: boolean }> = [
    { label: 'CEO profile', detail: '10x goal · intake · industry' },
    {
      label: 'Previous cycle',
      detail: prevCycle ? prevCycle.label : '— first cycle —',
      dim: !prevCycle,
    },
    {
      label: 'This cycle inputs',
      detail: `${submissionsCount} submission${submissionsCount === 1 ? '' : 's'}`,
    },
    { label: 'Curriculum', detail: 'IPA + 10x methodology' },
  ];
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        What the AI will see
      </div>
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-center gap-2 py-0.5 text-[12px]"
          style={{ opacity: r.dim ? 0.5 : 1 }}
        >
          <span className="min-w-[100px] text-muted-foreground">{r.label}</span>
          <span className="font-mono text-[11px] text-foreground/80">{r.detail}</span>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-6 w-full text-[11px] text-muted-foreground"
        onClick={() => setInspectorOpen(true)}
      >
        Inspect prompt →
      </Button>
      <PromptInspector
        cycleId={cycle.id}
        cycleLabel={cycle.label}
        ceoName={ceoName}
        open={inspectorOpen}
        onOpenChange={setInspectorOpen}
      />
    </div>
  );
}

function RecentReports({ ceoId, ceoName }: { ceoId: string; ceoName: string }) {
  // Use cycleSummary cache to find recent reports for this CEO without
  // an extra query — we already have the per-cycle phase + generatedAt.
  // Anchored to `hasReport`/`generatedAt` (authoritative server fields)
  // rather than `phase` so that even unusual phase states still surface
  // a generated report — phase is derived state and prone to skew when
  // the cache is mid-invalidation.
  const { data } = trpc.roster.cycleSummary.useQuery();
  const [openCycle, setOpenCycle] = useState<{
    id: string;
    label: string;
    periodStart: string | null;
    periodEnd: string | null;
  } | null>(null);

  const recent = useMemo(() => {
    const summary = data?.find((s) => s.ceo.id === ceoId);
    if (!summary) return [];
    return [...summary.cycles]
      .filter((c) => c.hasReport || !!c.generatedAt)
      .sort((a, b) => {
        const ak = a.generatedAt ?? '';
        const bk = b.generatedAt ?? '';
        return ak < bk ? 1 : ak > bk ? -1 : 0;
      })
      .slice(0, 5);
  }, [data, ceoId]);

  return (
    <>
      <div className="rounded-lg border border-border bg-background p-3">
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <FilePlus className="h-3 w-3" />
          Recent reports
        </div>
        {recent.length === 0 ? (
          <div className="text-[12px] italic text-muted-foreground">No reports yet</div>
        ) : (
          <div className="grid gap-0.5">
            {recent.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  setOpenCycle({
                    id: c.id,
                    label: c.label,
                    periodStart: c.periodStart,
                    periodEnd: c.periodEnd,
                  })
                }
                className="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] transition-colors hover:bg-muted/40"
              >
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background:
                      c.phase === 'sent' ? 'oklch(55% 0.12 152)' : 'oklch(58% 0.14 258)',
                  }}
                />
                <span className="flex-1 truncate">{c.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {c.generatedAt
                    ? new Date(c.generatedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })
                    : c.phase}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {openCycle && (
        <ReportDocumentModal
          cycleId={openCycle.id}
          ceoName={ceoName}
          cycleLabel={openCycle.label}
          periodStart={openCycle.periodStart}
          periodEnd={openCycle.periodEnd}
          open={!!openCycle}
          onOpenChange={(o) => {
            if (!o) setOpenCycle(null);
          }}
        />
      )}
    </>
  );
}
