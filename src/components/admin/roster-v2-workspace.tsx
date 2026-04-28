'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  FileText,
  Mail,
  Pencil,
  AlertTriangle,
  Check,
  CheckCircle2,
  Plus,
  Sparkles,
  RefreshCw,
  FilePlus,
  Download,
  ChevronDown,
  ChevronRight,
  Target,
  CalendarRange,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/api/root';
import type {
  RosterCeoSummary,
  RosterCycle,
} from '@/server/api/routers/roster';
import { CONTENT_TYPE_DOT, fmtShortDate, PHASE_DOT, dayOffset, relativeDay, deriveCycleLabel } from './roster-v2-shared';
import { CycleEditDialog } from './roster-v2-cycle-edit-dialog';
import { CycleCreateDialog } from './roster-v2-cycle-create-dialog';
import { NotesEditor } from './roster-v2-notes-editor';
import { CycleFieldEditor } from './roster-v2-cycle-field-editor';
import { PromptInspector } from './prompt-inspector';
import { ManualTranscriptDialog } from './manual-transcript-dialog';
import { AddWeekDialog } from './add-week-dialog';
import { ReportReviewer } from './report-reviewer';
import { ZoomImportDialog } from '@/components/cycles/zoom-import-dialog';

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
      {/* Cycle tabs */}
      <div
        className="flex items-center gap-1 border-b border-border px-12"
        style={{ paddingTop: 8 }}
      >
        {cycles.map((c) => {
          const active = c.id === activeCycleId;
          return (
            <button
              key={c.id}
              onClick={() => onActiveCycleIdChange(c.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
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
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          style={{ marginBottom: -1 }}
        >
          <Plus className="h-3 w-3" /> New cycle
        </button>
        <span className="flex-1" />
      </div>

      <CycleBody
        ceo={summary.ceo}
        cycle={cycle}
        prevCycle={prevCycle}
        reviewKey={reviewKey}
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
  cycle,
  prevCycle,
  reviewKey,
}: {
  ceo: RosterCeoSummary['ceo'];
  cycle: RosterCycle;
  prevCycle: RosterCycle | null;
  reviewKey?: number;
}) {
  const detail = trpc.roster.cycleDetail.useQuery({ cycleId: cycle.id });
  const data = detail.data;

  const totalReady = Object.values(cycle.readiness).filter((r) => r.done).length;
  const totalSlots = 6;
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
        {/* 10x goal callout — context for the AI summary, prominent so the
            super admin can see what each CEO is working toward without
            jumping to the profile. */}
        <TenXGoalCallout ceoName={ceo.name} ceoId={ceo.id} tenXGoal={ceo.tenXGoal} />

        {/* Header row */}
        <div className="mb-1 flex items-baseline gap-3">
          <div className="text-base font-semibold">{deriveCycleLabel(cycle)}</div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {cycle.periodStart && fmtShortDate(cycle.periodStart)}
            {' → '}
            {cycle.periodEnd && fmtShortDate(cycle.periodEnd)}
            {' · session period for '}
            {ceo.name}
          </div>
          <button
            onClick={() => setEditCycleOpen(true)}
            className="inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            aria-label="Edit cycle"
          >
            <CalendarRange className="h-3 w-3" /> edit dates
          </button>
        </div>

        {/* Day-precise mini timeline */}
        <CycleSubmissionsStrip cycle={cycle} />

        <CycleEditDialog
          cycle={{
            id: cycle.id,
            label: cycle.label,
            periodStart: cycle.periodStart,
            periodEnd: cycle.periodEnd,
          }}
          open={editCycleOpen}
          onOpenChange={setEditCycleOpen}
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

        {/* Input slots */}
        <InputSlot
          icon="zoom"
          title="Zoom Transcript"
          status={cycle.readiness.tx.done ? 'done' : 'empty'}
          right={
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => setZoomImportOpen(true)}
              >
                <Download className="mr-1 h-3 w-3" /> Import from Zoom
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => setPasteTranscriptOpen(true)}
              >
                <FilePlus className="mr-1 h-3 w-3" /> Paste text
              </Button>
            </div>
          }
        >
          {data?.transcripts.length ? (
            data.transcripts.map((t) => (
              <ExpandableEntry
                key={t.id}
                title={t.title || 'Untitled meeting'}
                sub={`${t.zoomMeetingId ? 'Zoom' : 'Manual'}${t.recordedAt ? ` · ${fmtShortDate(new Date(t.recordedAt).toISOString().slice(0, 10))}` : ''}${t.duration ? ` · ${t.duration} min` : ''}`}
                dotColor={CONTENT_TYPE_DOT.transcript}
                content={t.content}
                meta={`${(t.content ?? '').length.toLocaleString()} chars`}
              />
            ))
          ) : (
            <EmptyHint label="No transcript for this session" />
          )}
        </InputSlot>

        <ManualTranscriptDialog
          cycleId={cycle.id}
          open={pasteTranscriptOpen}
          onOpenChange={setPasteTranscriptOpen}
        />

        <ZoomImportDialog
          cycleId={cycle.id}
          ceoId={ceo.id}
          hasZoomEmail={hasZoomEmail}
          existingTranscripts={data?.transcripts ?? []}
          open={zoomImportOpen}
          onOpenChange={setZoomImportOpen}
        />

        <InputSlot
          icon="note"
          title="Extra Notes & Context"
          status={data?.cycle.additionalContext?.trim() ? 'done' : 'optional'}
        >
          {data ? (
            <NotesEditor cycleId={cycle.id} initialValue={data.cycle.additionalContext} />
          ) : (
            <div className="px-1 text-[11px] text-muted-foreground">Loading…</div>
          )}
        </InputSlot>

        <InputSlot
          icon="goals"
          title="Monthly Goals & Commitments"
          status={cycle.readiness.goals.done ? 'done' : 'empty'}
          aiSuggested={cycle.readiness.goals.ai}
        >
          {data ? (
            cycle.readiness.goals.done || cycle.readiness.goals.ai ? (
              <CycleFieldEditor
                cycleId={cycle.id}
                field="monthlyGoals"
                initialValue={data.cycle.monthlyGoals}
                ai={cycle.readiness.goals.ai}
                rows={6}
              />
            ) : (
              <EmptyHint
                label="No monthly goals captured yet"
                cta={
                  <PrefillButton
                    cycleId={cycle.id}
                    field="monthlyGoals"
                    label="AI prefill from transcript"
                  />
                }
              />
            )
          ) : (
            <div className="px-1 text-[11px] text-muted-foreground">Loading…</div>
          )}
        </InputSlot>

        <InputSlot
          icon="weekly"
          title="Weekly Journals"
          status={
            cycle.readiness.weekly.done
              ? 'done'
              : (data?.journals.length ?? 0) > 0
                ? 'partial'
                : 'empty'
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
          icon="reflect"
          title="Monthly Reflection"
          status={cycle.readiness.reflect.done ? 'done' : 'empty'}
          aiSuggested={cycle.readiness.reflect.ai}
        >
          {data ? (
            cycle.readiness.reflect.done || cycle.readiness.reflect.ai ? (
              <CycleFieldEditor
                cycleId={cycle.id}
                field="monthlyReflection"
                initialValue={data.cycle.monthlyReflection}
                ai={cycle.readiness.reflect.ai}
                rows={8}
              />
            ) : (
              <EmptyHint
                label="No reflection captured yet"
                cta={
                  <PrefillButton
                    cycleId={cycle.id}
                    field="monthlyReflection"
                    label="AI prefill from journals + transcript"
                  />
                }
              />
            )
          ) : (
            <div className="px-1 text-[11px] text-muted-foreground">Loading…</div>
          )}
        </InputSlot>

        <ActionItemsSlot cycleId={cycle.id} ceoId={ceo.id} data={data} readinessDone={cycle.readiness.actions.done} />
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
        <ContextInspector
          ceoId={ceo.id}
          ceoName={ceo.name}
          cycle={cycle}
          prevCycle={prevCycle}
          submissionsCount={data?.rawInputs.length ?? cycle.submissions.length}
        />
        <RecentReports ceoId={ceo.id} />
      </div>
    </div>
  );
}

function CycleSubmissionsStrip({ cycle }: { cycle: RosterCycle }) {
  if (!cycle.periodStart || !cycle.periodEnd) return null;
  const start = new Date(cycle.periodStart);
  const end = new Date(cycle.periodEnd);
  const span = (end.getTime() - start.getTime()) / 86_400_000;
  if (span <= 0) return null;
  return (
    <div className="relative h-7 rounded border border-border bg-background px-1.5">
      <div className="absolute left-2 top-1.5 font-mono text-[10px] text-muted-foreground">
        {fmtShortDate(cycle.periodStart)}
      </div>
      <div className="absolute right-2 top-1.5 font-mono text-[10px] text-muted-foreground">
        {fmtShortDate(cycle.periodEnd)}
      </div>
      {cycle.submissions.map((s) => {
        const sd = new Date(s.occurredAt);
        const offset = (sd.getTime() - start.getTime()) / 86_400_000;
        const pct = (offset / span) * 100;
        if (pct < 0 || pct > 100) return null;
        const color = CONTENT_TYPE_DOT[s.type] ?? 'var(--muted-foreground)';
        const unconfirmed = s.status.includes('unconfirmed');
        const today = new Date();
        return (
          <span
            key={s.rawInputId}
            title={`${s.type} · ${relativeDay(dayOffset(s.occurredAt, today))}`}
            className="absolute"
            style={{
              left: `${pct}%`,
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 8,
              height: 8,
              borderRadius: 4,
              background: unconfirmed ? 'transparent' : color,
              border: `1.5px solid ${color}`,
            }}
          />
        );
      })}
    </div>
  );
}

type CycleDetailData = inferRouterOutputs<AppRouter>['roster']['cycleDetail'];

function ActionItemsSlot({
  cycleId,
  ceoId,
  data,
  readinessDone,
}: {
  cycleId: string;
  ceoId: string;
  data: CycleDetailData | undefined;
  readinessDone: boolean;
}) {
  const utils = trpc.useUtils();
  const items = data?.actionItems ?? [];
  const total = data?.actionsBucketed.total ?? items.length;
  const reviewedCount = data?.actionsBucketed.reviewed ?? 0;
  const isEmpty = total === 0;
  const allReviewed = !isEmpty && reviewedCount === total;

  const updateItem = trpc.actionItems.update.useMutation({
    onSuccess: () => {
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
      utils.actionItems.listForCycle.invalidate({ cycleId });
    },
  });
  const setAll = trpc.actionItems.setAllReviewed.useMutation({
    onSuccess: () => {
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
      utils.actionItems.listForCycle.invalidate({ cycleId });
    },
  });

  return (
    <InputSlot
      icon="actions"
      title="Action Items"
      status={readinessDone ? 'done' : 'empty'}
      countLabel={
        isEmpty
          ? 'auto-reviewed (no items)'
          : `${reviewedCount}/${total} reviewed`
      }
      right={
        !isEmpty ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={setAll.isPending}
            onClick={() =>
              setAll.mutate({ cycleId, reviewed: !allReviewed })
            }
          >
            {setAll.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1 h-3 w-3" />
            )}
            {allReviewed ? 'Unreview all' : 'Mark all reviewed'}
          </Button>
        ) : undefined
      }
    >
      {isEmpty ? (
        <div className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          No action items — section auto-reviewed.
        </div>
      ) : (
        <div className="grid gap-1.5">
          {items.slice(0, 3).map((a) => (
            <div
              key={a.id}
              className={cn(
                'flex items-center gap-2 rounded border px-2.5 py-1.5 text-[12px] transition-colors',
                a.reviewed
                  ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
                  : 'border-border bg-background'
              )}
            >
              <Checkbox
                checked={a.reviewed}
                onCheckedChange={(v) =>
                  updateItem.mutate({ id: a.id, reviewed: v === true })
                }
                aria-label={a.reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
                className="shrink-0"
              />
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    a.status === 'done'
                      ? 'oklch(55% 0.12 152)'
                      : a.status === 'dropped'
                        ? 'var(--muted-foreground)'
                        : 'oklch(58% 0.13 64)',
                }}
              />
              <span className={cn('truncate', a.reviewed && 'text-foreground/70')}>
                {a.item}
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">{a.owner}</span>
            </div>
          ))}
          {items.length > 3 && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
            >
              <Link href={`/ceos/${ceoId}/cycles/${cycleId}`}>
                + {items.length - 3} more
              </Link>
            </Button>
          )}
        </div>
      )}
    </InputSlot>
  );
}

function InputSlot({
  icon,
  title,
  status,
  countLabel,
  children,
  right,
  aiSuggested,
}: {
  icon: 'zoom' | 'note' | 'goals' | 'weekly' | 'reflect' | 'actions';
  title: string;
  status: 'done' | 'empty' | 'partial' | 'optional';
  countLabel?: string;
  children?: React.ReactNode;
  right?: React.ReactNode;
  aiSuggested?: boolean;
}) {
  const dotColor = {
    done: 'oklch(55% 0.12 152)',
    empty: 'var(--border)',
    partial: 'oklch(58% 0.13 64)',
    optional: 'var(--border)',
  }[status];

  const Icon = {
    zoom: Mail,
    note: FileText,
    goals: Pencil,
    weekly: FileText,
    reflect: FileText,
    actions: Check,
  }[icon];

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: dotColor }} />
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="text-[13px] font-medium">{title}</div>
        {aiSuggested && <AiBadge />}
        <span className="flex-1" />
        {countLabel && <span className="font-mono text-[11px] text-muted-foreground">{countLabel}</span>}
        {right && <div className="flex items-center gap-1">{right}</div>}
      </div>
      <div className="grid gap-1.5">{children}</div>
    </div>
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

function TenXGoalCallout({
  ceoName,
  ceoId,
  tenXGoal,
}: {
  ceoName: string;
  ceoId: string;
  tenXGoal: string | null;
}) {
  const has = !!tenXGoal?.trim();
  const [expanded, setExpanded] = useState(false);
  return (
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
          {ceoName}&apos;s 10x goal
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
        <Link
          href={`/ceos/${ceoId}`}
          className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
        >
          edit on profile →
        </Link>
      </div>
      {has ? (
        expanded ? (
          <div className="max-h-40 overflow-y-auto pr-1">
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
              {tenXGoal}
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
            {tenXGoal}
          </p>
        )
      ) : (
        <p className="text-[12px] italic text-muted-foreground">
          No 10x goal set — open the CEO profile to capture one.
        </p>
      )}
    </div>
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
  const [reviewOpen, setReviewOpen] = useState(false);

  // Auto-open the report reviewer when the parent row's "Review →" button
  // is clicked. The row bumps `reviewKey` each time so consecutive clicks
  // re-open the dialog after the user has dismissed it. Only fires when
  // a report is actually available for this cycle.
  useEffect(() => {
    if (reviewKey === undefined || reviewKey === 0) return;
    if (cycle.phase === 'generated' || cycle.phase === 'sent') {
      setReviewOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewKey]);
  const generate = trpc.reports.generate.useMutation({
    onSuccess: () => {
      utils.roster.cycleSummary.invalidate();
      utils.roster.cycleDetail.invalidate({ cycleId: cycle.id });
      utils.reports.getForCycle.invalidate({ cycleId: cycle.id });
      setConfirmGapsOpen(false);
      setReviewOpen(true);
    },
  });
  const items: Array<{ key: keyof RosterCycle['readiness']; label: string }> = [
    { key: 'tenx', label: '10x goal' },
    { key: 'goals', label: 'Monthly goals' },
    { key: 'reflect', label: 'Monthly reflection' },
    { key: 'weekly', label: 'Weekly journals (≥3)' },
    { key: 'tx', label: 'Zoom transcript' },
    { key: 'actions', label: 'Action items reviewed' },
  ];

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
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className="grid h-5 w-5 place-items-center rounded text-[12px] text-white"
          style={{
            background: isReady ? 'oklch(55% 0.12 152)' : 'var(--muted)',
            color: isReady ? 'white' : 'var(--muted-foreground)',
          }}
        >
          {isReady ? '✓' : ' '}
        </span>
        <div className={cn('text-[13px] font-semibold', isReady && 'text-[oklch(55%_0.12_152)]')}>
          {isReady ? 'All inputs complete' : `${totalReady} of ${totalSlots} inputs ready`}
        </div>
      </div>
      <div className="mb-3 grid gap-1">
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
      <div className="grid gap-1.5">
        {cycle.phase === 'sent' && (
          <Button asChild variant="outline" size="sm" className="h-7 text-xs">
            <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>View sent report</Link>
          </Button>
        )}
        {cycle.phase === 'generated' && (
          <Button
            size="sm"
            className="h-7 text-xs"
            style={{ background: 'oklch(58% 0.14 258)' }}
            onClick={() => setReviewOpen(true)}
          >
            Review report
          </Button>
        )}
        {(cycle.phase === 'ready' || cycle.phase === 'gathering') && (
          <>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={generate.isPending}
              style={
                isReady
                  ? { background: 'oklch(58% 0.14 258)' }
                  : {
                      background: 'color-mix(in oklab, oklch(58% 0.13 64), transparent 88%)',
                      color: 'oklch(58% 0.13 64)',
                      border: '1px solid color-mix(in oklab, oklch(58% 0.13 64), transparent 60%)',
                    }
              }
              onClick={() => {
                if (isReady) generate.mutate({ cycleId: cycle.id });
                else setConfirmGapsOpen(true);
              }}
            >
              {generate.isPending ? (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              ) : isReady ? (
                <Mail className="mr-1.5 h-3 w-3" />
              ) : (
                <AlertTriangle className="mr-1.5 h-3 w-3" />
              )}
              {generate.isPending
                ? 'Generating…'
                : isReady
                  ? 'Generate Email'
                  : 'Generate with gaps'}
            </Button>
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
              isPending={generate.isPending}
              onConfirm={() => generate.mutate({ cycleId: cycle.id })}
            />
          </>
        )}
        <ReportReviewer
          cycleId={cycle.id}
          ceoName={ceoName}
          cycleLabel={cycle.label}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
        />
        {cycle.phase === 'idle' && (
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
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ceoName: string;
  cycleLabel: string;
  missing: string[];
  isPending: boolean;
  onConfirm: () => void;
}) {
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
            The AI will use what&apos;s there and flag the missing pieces in
            the email.
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

function RecentReports({ ceoId }: { ceoId: string }) {
  // Use cycleSummary cache to find recent reports for this CEO without
  // an extra query — we already have the per-cycle phase + generatedAt.
  const { data } = trpc.roster.cycleSummary.useQuery();
  const recent = useMemo(() => {
    const summary = data?.find((s) => s.ceo.id === ceoId);
    if (!summary) return [];
    return [...summary.cycles]
      .filter((c) => c.phase === 'sent' || c.phase === 'generated')
      .slice(-3)
      .reverse();
  }, [data, ceoId]);

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <FilePlus className="h-3 w-3" />
        Recent reports
      </div>
      {recent.length === 0 ? (
        <div className="text-[12px] italic text-muted-foreground">No reports yet</div>
      ) : (
        <div className="grid gap-1">
          {recent.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-0.5 text-[12px]">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    c.phase === 'sent' ? 'oklch(55% 0.12 152)' : 'oklch(58% 0.14 258)',
                }}
              />
              <span className="flex-1">{c.label}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{c.phase}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
