'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, Mail, Pencil, ExternalLink, AlertTriangle, Check, Plus, Sparkles, Undo2, RefreshCw, FilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  RosterCeoSummary,
  RosterCycle,
  RosterReadiness,
} from '@/server/api/routers/roster';
import { CONTENT_TYPE_DOT, fmtShortDate, PHASE_DOT, dayOffset, relativeDay } from './roster-v2-shared';

interface Props {
  summary: RosterCeoSummary;
  cycles: RosterCycle[];
  initialActiveCycleId: string;
}

/**
 * Inline workspace shown when a row is expanded. Mirrors the standalone
 * cycle page but denser. The user can switch between this CEO's cycles via
 * tabs at the top. Detail data is fetched on-demand per cycle.
 */
export function CycleWorkspace({ summary, cycles, initialActiveCycleId }: Props) {
  const [activeCycleId, setActiveCycleId] = useState(initialActiveCycleId);
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
              onClick={() => setActiveCycleId(c.id)}
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
              {c.label}
            </button>
          );
        })}
        <span className="flex-1" />
        <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground">
          <Link href={`/ceos/${summary.ceo.id}/cycles/${cycle.id}`}>
            <ExternalLink className="mr-1 h-3 w-3" />
            Open full page
          </Link>
        </Button>
      </div>

      <CycleBody
        ceo={summary.ceo}
        cycle={cycle}
        prevCycle={prevCycle}
      />
    </div>
  );
}

function CycleBody({
  ceo,
  cycle,
  prevCycle,
}: {
  ceo: RosterCeoSummary['ceo'];
  cycle: RosterCycle;
  prevCycle: RosterCycle | null;
}) {
  const detail = trpc.roster.cycleDetail.useQuery({ cycleId: cycle.id });
  const data = detail.data;

  const totalReady = (Object.values(cycle.readiness) as RosterReadiness[keyof RosterReadiness][]).filter((r) => r.done).length;
  const totalSlots = 6;
  const isReady = totalReady === totalSlots;

  return (
    <div className="grid grid-cols-1 gap-6 px-12 py-5 lg:grid-cols-[1fr_280px]">
      {/* Left column — input slots */}
      <div className="grid gap-3">
        {/* Header row */}
        <div className="mb-1 flex items-baseline gap-3">
          <div className="text-base font-semibold">{cycle.label}</div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {cycle.periodStart && fmtShortDate(cycle.periodStart)}
            {' → '}
            {cycle.periodEnd && fmtShortDate(cycle.periodEnd)}
            {' · session period for '}
            {ceo.name}
          </div>
        </div>

        {/* Day-precise mini timeline */}
        <CycleSubmissionsStrip cycle={cycle} />

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
            <Button asChild size="sm" variant="outline" className="h-6 px-2 text-[11px]">
              <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>Import from Zoom</Link>
            </Button>
          }
        >
          {data?.transcripts.length ? (
            data.transcripts.slice(0, 3).map((t) => (
              <SubmissionPreview
                key={t.id}
                title={t.title || 'Untitled meeting'}
                sub={`Zoom · ${t.recordedAt ? fmtShortDate(t.recordedAt.toString().slice(0, 10)) : '—'}${t.duration ? ` · ${t.duration} min` : ''}`}
                dotColor={CONTENT_TYPE_DOT.transcript}
              />
            ))
          ) : (
            <EmptyHint label="No transcript for this session" />
          )}
        </InputSlot>

        <InputSlot icon="note" title="Extra Notes & Context" status="optional">
          {cycle.readiness ? (
            <p className="px-1 py-1 text-[12px] italic text-muted-foreground">
              {(data?.cycle?.additionalContext?.trim()
                ? data.cycle.additionalContext.slice(0, 220)
                : 'Paste any additional context — emails, notes, meeting prep — that should inform this session.')}
            </p>
          ) : null}
        </InputSlot>

        <InputSlot
          icon="goals"
          title="Monthly Goals & Commitments"
          status={cycle.readiness.goals.done ? 'done' : 'empty'}
          aiSuggested={cycle.readiness.goals.ai}
          right={
            <>
              {cycle.readiness.goals.ai && (
                <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
                  <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
                    <Undo2 className="mr-1 h-3 w-3" /> Undo
                  </Link>
                </Button>
              )}
              <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
                <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
                  <RefreshCw className="mr-1 h-3 w-3" /> Re-generate
                </Link>
              </Button>
            </>
          }
        >
          {cycle.readiness.goals.done ? (
            <BodyText ai={cycle.readiness.goals.ai}>
              {data?.cycle.monthlyGoals?.trim() ?? '(loading…)'}
            </BodyText>
          ) : (
            <EmptyHint
              label="No monthly goals captured yet"
              cta={
                <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
                  <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
                    <Sparkles className="mr-1 h-3 w-3" /> AI prefill from transcript
                  </Link>
                </Button>
              }
            />
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
              {data.journals.map((j) => (
                <SubmissionPreview
                  key={j.id}
                  title={j.title || `Week ${j.weekNumber}`}
                  sub={`Tally · Week ${j.weekNumber}`}
                  dotColor={CONTENT_TYPE_DOT.weekly_journal}
                  compact
                />
              ))}
            </div>
          ) : (
            <EmptyHint label="No weekly journals yet" />
          )}
          <Button asChild variant="outline" size="sm" className="mt-1 h-7 w-full border-dashed text-xs text-muted-foreground">
            <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
              <Plus className="mr-1 h-3 w-3" />
              Add week
            </Link>
          </Button>
        </InputSlot>

        <InputSlot
          icon="reflect"
          title="Monthly Reflection"
          status={cycle.readiness.reflect.done ? 'done' : 'empty'}
          aiSuggested={cycle.readiness.reflect.ai}
          right={
            <>
              {cycle.readiness.reflect.ai && (
                <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
                  <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
                    <Undo2 className="mr-1 h-3 w-3" /> Undo
                  </Link>
                </Button>
              )}
              <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
                <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
                  <RefreshCw className="mr-1 h-3 w-3" /> Re-generate
                </Link>
              </Button>
            </>
          }
        >
          {cycle.readiness.reflect.done ? (
            <BodyText ai={cycle.readiness.reflect.ai}>
              {data?.cycle.monthlyReflection?.trim() ?? '(loading…)'}
            </BodyText>
          ) : (
            <EmptyHint
              label="No reflection captured yet"
              cta={
                <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
                  <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
                    <Sparkles className="mr-1 h-3 w-3" /> AI prefill from journals + transcript
                  </Link>
                </Button>
              }
            />
          )}
        </InputSlot>

        <InputSlot
          icon="actions"
          title="Action Items"
          status={cycle.readiness.actions.done ? 'done' : 'empty'}
          countLabel={
            data
              ? `${data.actionsBucketed.open} open · ${data.actionsBucketed.done} done · ${data.actionsBucketed.dropped} dropped`
              : '— · — · —'
          }
        >
          {data?.actionItems.length ? (
            <div className="grid gap-1.5">
              {data.actionItems.slice(0, 3).map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 rounded border border-border bg-background px-2.5 py-1.5 text-[12px]"
                >
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
                  <span className="truncate">{a.item}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{a.owner}</span>
                </div>
              ))}
              {data.actionItems.length > 3 && (
                <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-muted-foreground">
                  <Link href={`/ceos/${ceo.id}/cycles/${cycle.id}`}>
                    + {data.actionItems.length - 3} more
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <EmptyHint label="No action items reviewed for this cycle" />
          )}
        </InputSlot>
      </div>

      {/* Right rail */}
      <div className="grid gap-3 self-start">
        <ReadinessCard ceoId={ceo.id} cycle={cycle} totalReady={totalReady} totalSlots={totalSlots} isReady={isReady} />
        <ContextInspector
          ceoId={ceo.id}
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

function SubmissionPreview({
  title,
  sub,
  dotColor,
  compact,
}: {
  title: string;
  sub?: string;
  dotColor: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded border border-border bg-muted/30',
        compact ? 'px-2.5 py-1.5' : 'px-2.5 py-2'
      )}
    >
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
  cycle,
  totalReady,
  totalSlots,
  isReady,
}: {
  ceoId: string;
  cycle: RosterCycle;
  totalReady: number;
  totalSlots: number;
  isReady: boolean;
}) {
  const items: Array<{ key: keyof RosterCycle['readiness']; label: string }> = [
    { key: 'tenx', label: '10x goal' },
    { key: 'goals', label: 'Monthly goals' },
    { key: 'reflect', label: 'Monthly reflection' },
    { key: 'weekly', label: 'Weekly journals (≥3)' },
    { key: 'tx', label: 'Zoom transcript' },
    { key: 'actions', label: 'Action items reviewed' },
  ];
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
          <>
            <Button
              asChild
              size="sm"
              className="h-7 text-xs"
              style={{ background: 'oklch(58% 0.14 258)' }}
            >
              <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>Review report</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
              <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>
                <RefreshCw className="mr-1 h-3 w-3" /> Re-generate
              </Link>
            </Button>
          </>
        )}
        {(cycle.phase === 'ready' || cycle.phase === 'gathering') && (
          <Button
            asChild={isReady}
            size="sm"
            className="h-7 text-xs"
            disabled={!isReady}
            style={isReady ? { background: 'oklch(58% 0.14 258)' } : {}}
          >
            {isReady ? (
              <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>
                <Mail className="mr-1.5 h-3 w-3" />
                Generate Email
              </Link>
            ) : (
              <span>Generate Email</span>
            )}
          </Button>
        )}
        {cycle.phase === 'idle' && (
          <Button variant="ghost" size="sm" className="h-7 text-xs">
            Send nudge
          </Button>
        )}
      </div>
    </div>
  );
}

function ContextInspector({
  ceoId,
  cycle,
  prevCycle,
  submissionsCount,
}: {
  ceoId: string;
  cycle: RosterCycle;
  prevCycle: RosterCycle | null;
  submissionsCount: number;
}) {
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
        asChild
        variant="outline"
        size="sm"
        className="mt-2 h-6 w-full text-[11px] text-muted-foreground"
      >
        <Link href={`/ceos/${ceoId}/cycles/${cycle.id}`}>Inspect prompt →</Link>
      </Button>
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
