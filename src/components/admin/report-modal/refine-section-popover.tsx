'use client';

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Check,
  ChevronRight,
  Loader2,
  Pencil,
  Sparkles,
  Undo2,
} from 'lucide-react';

/**
 * Inline per-section refinement popover.
 *
 * Replaces the previous full side-drawer chat. The new affordance is a
 * small (~420px) popover anchored to the section's icon with two
 * modes:
 *
 *   1. **AI Refine** — a short textarea + a "Refine" button. Submitting
 *      calls `refineSectionV2` which (a) generates a new section value,
 *      (b) auto-applies it to the persisted contentJson so the document
 *      below updates instantly. An "Undo last refinement" button shows
 *      up afterwards.
 *
 *   2. **Edit raw** — direct textarea over the current section value.
 *      Saves via `reports.update` so the coach can type the exact words
 *      themselves without going through the model.
 *
 * Context preservation: the AI refine path passes the full raw cycle
 * inputs (journals, transcripts, KPIs) to the model — not just the
 * typed CycleFacts — so refinements like "pull in that specific quote
 * from Dave's Week 3" can actually find the quote. See refine-section.ts.
 */

const REFINABLE_LABELS: Record<string, string> = {
  progressSummary: 'Progress Summary',
  keyWins: 'Key Wins',
  challenges: 'Challenges',
  patternObservations: 'Pattern Observations',
  suggestedNextSteps: 'Suggested Next Steps',
  opening: 'Email opening',
  wins_and_progress: 'Email — wins',
  honest_feedback: 'Email — honest feedback',
  key_insight: 'Email — key insight',
  commitments: 'Email — commitments',
};

const LIST_SECTIONS = new Set([
  'keyWins',
  'challenges',
  'suggestedNextSteps',
]);

type Props = {
  reportId: string;
  section: string;
};

export function RefineSectionPopover({ reportId, section }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          aria-label={`Edit ${section}`}
          title="Edit this section (AI refine or raw edit)"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[420px] p-0"
        onOpenAutoFocus={(e) => {
          // Don't auto-focus the textarea — Radix's default jumps the
          // page when the popover renders below the fold. The user
          // will tab/click into the field themselves.
          e.preventDefault();
        }}
      >
        {open && <PopoverBody reportId={reportId} section={section} />}
      </PopoverContent>
    </Popover>
  );
}

function PopoverBody({ reportId, section }: Props) {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<'ai' | 'raw'>('ai');

  // ── Data we need ─────────────────────────────────────────────────
  // - Current report so we can show the section's current value in raw
  //   mode. getForCycle covers it via the modal's existing query — but
  //   to keep this component self-contained, fetch just what we need
  //   via getForReport (a thin endpoint) OR rely on listRefinements +
  //   contentJson from the parent. Simpler: use listRefinements (which
  //   we already need for history) and pass the section's current value
  //   in via a per-component fetch.
  //
  // We piggy-back on the existing getForCycle cache by reading from
  // tRPC utils — the parent's already populated it. Falls back to a
  // direct fetch if the cache misses.
  const reportQ = trpc.reports.getForReportId.useQuery(
    { reportId },
    { staleTime: 5_000 },
  );
  const refinementsQ = trpc.reports.listRefinements.useQuery(
    { reportId },
    { staleTime: 5_000 },
  );

  const sectionTurns = useMemo(
    () => refinementsQ.data?.[section] ?? [],
    [refinementsQ.data, section],
  );
  const recentAssistantTurns = useMemo(
    () => sectionTurns.filter((t) => t.role === 'assistant').slice(-3).reverse(),
    [sectionTurns],
  );
  const hasUndoable = recentAssistantTurns.length > 0;

  const currentValue = useMemo(
    () => extractSectionValue(reportQ.data?.contentJson, section),
    [reportQ.data?.contentJson, section],
  );

  // ── Mutations ────────────────────────────────────────────────────
  // Critical: the report modal renders from `getReportVersions`, not
  // `getForCycle` — invalidate BOTH so the document below the popover
  // repaints with the new section as soon as the mutation lands. Same
  // for revert + raw edit. Without the getReportVersions invalidate,
  // the section saves to the DB but the user has to refresh the page
  // to see the change.
  const refine = trpc.reports.refineSectionV2.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.getForCycle.invalidate(),
        utils.reports.getForReportId.invalidate({ reportId }),
        utils.reports.getReportVersions.invalidate(),
        utils.reports.listRefinements.invalidate({ reportId }),
      ]);
      setMessage('');
    },
  });

  const revert = trpc.reports.revertSectionToPriorTurn.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.getForCycle.invalidate(),
        utils.reports.getForReportId.invalidate({ reportId }),
        utils.reports.getReportVersions.invalidate(),
        utils.reports.listRefinements.invalidate({ reportId }),
      ]);
    },
  });

  const updateRaw = trpc.reports.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.getForCycle.invalidate(),
        utils.reports.getForReportId.invalidate({ reportId }),
        utils.reports.getReportVersions.invalidate(),
      ]);
    },
  });

  const [message, setMessage] = useState('');
  const [rawDraft, setRawDraft] = useState<string>('');
  const [historyOpen, setHistoryOpen] = useState(false);

  // Sync raw draft from the actual stored value whenever it changes or
  // we switch to raw mode. We don't auto-overwrite while the coach is
  // mid-edit (rawDraft already populated and different) unless they
  // explicitly switch tabs.
  useEffect(() => {
    if (tab === 'raw') {
      const next = listToText(currentValue);
      setRawDraft(next);
    }
  }, [tab, currentValue]);

  const isList = LIST_SECTIONS.has(section);

  function submitAi() {
    if (!message.trim() || refine.isPending) return;
    refine.mutate({
      reportId,
      section: section as Parameters<typeof refine.mutate>[0]['section'],
      message: message.trim(),
    });
  }

  function submitRaw() {
    if (updateRaw.isPending) return;
    const value = isList
      ? rawDraft
          .split('\n')
          .map((l) => l.replace(/^[-*•]\s*/, '').trim())
          .filter(Boolean)
      : rawDraft;
    updateRaw.mutate({
      reportId,
      [section]: value as never,
    });
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold">
            Refine — {REFINABLE_LABELS[section] ?? section}
          </p>
          <p className="text-[10.5px] text-muted-foreground">
            {tab === 'ai'
              ? 'Tell the AI what to change. The section below updates as soon as it lands.'
              : 'Edit the text directly. Skips the AI entirely.'}
          </p>
        </div>
        <TabSwitch tab={tab} onTabChange={setTab} />
      </div>

      {/* Body — AI mode */}
      {tab === 'ai' && (
        <div className="flex flex-col gap-2 p-3">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder='e.g. "make this more specific to the COO hire", "tighten this to 3 bullets", "soften the personal note"'
            rows={3}
            className="text-[12px]"
            disabled={refine.isPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitAi();
              }
            }}
          />

          {refine.error && (
            <p className="text-[11px] text-destructive">{refine.error.message}</p>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {hasUndoable && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-muted-foreground"
                  disabled={revert.isPending}
                  onClick={() =>
                    revert.mutate({
                      reportId,
                      section: section as Parameters<typeof revert.mutate>[0]['section'],
                    })
                  }
                  title="Undo the most recent AI refinement on this section"
                >
                  {revert.isPending ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Undo2 className="mr-1 h-3 w-3" />
                  )}
                  Undo last
                </Button>
              )}
            </div>
            <Button
              size="sm"
              onClick={submitAi}
              disabled={refine.isPending || !message.trim()}
              className="h-7 text-[11px]"
            >
              {refine.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-3 w-3" />
              )}
              Refine
            </Button>
          </div>

          {/* Recent refinements collapsed list — gives the coach a quick
              memory of what they've already asked for so they don't
              repeat themselves. */}
          {recentAssistantTurns.length > 0 && (
            <div className="mt-1 rounded-md border border-border bg-muted/20 px-2 py-1.5">
              <button
                type="button"
                onClick={() => setHistoryOpen((o) => !o)}
                className="flex w-full items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    'h-2.5 w-2.5 transition-transform',
                    historyOpen && 'rotate-90',
                  )}
                />
                <span>
                  Recent refinements ({recentAssistantTurns.length})
                </span>
              </button>
              {historyOpen && (
                <ul className="mt-1.5 space-y-1 text-[11px]">
                  {recentAssistantTurns.map((t, i) => {
                    // Find the user turn paired with this assistant turn.
                    const all = sectionTurns;
                    const idx = all.findIndex((x) => x.id === t.id);
                    const prevUser = all
                      .slice(0, idx)
                      .reverse()
                      .find((x) => x.role === 'user');
                    return (
                      <li
                        key={t.id}
                        className="flex items-start gap-1.5 text-muted-foreground"
                      >
                        <Check className="mt-0.5 h-2.5 w-2.5 shrink-0 text-emerald-500" />
                        <span className="line-clamp-2">
                          {prevUser?.content ?? `(refinement ${i + 1})`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Body — Raw edit mode */}
      {tab === 'raw' && (
        <div className="flex flex-col gap-2 p-3">
          <Textarea
            value={rawDraft}
            onChange={(e) => setRawDraft(e.target.value)}
            rows={isList ? 7 : 9}
            className="text-[12px] font-mono"
            disabled={updateRaw.isPending}
            placeholder={
              isList
                ? 'One bullet per line. Leading "-" / "•" stripped automatically.'
                : 'Write the section exactly as it should appear.'
            }
          />
          {updateRaw.error && (
            <p className="text-[11px] text-destructive">{updateRaw.error.message}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10.5px] text-muted-foreground">
              {isList ? 'List section — one bullet per line.' : 'Prose section.'}
            </p>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setRawDraft(listToText(currentValue))}
                disabled={updateRaw.isPending}
              >
                Reset
              </Button>
              <Button
                size="sm"
                onClick={submitRaw}
                disabled={
                  updateRaw.isPending || rawDraft === listToText(currentValue)
                }
                className="h-7 text-[11px]"
              >
                {updateRaw.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Check className="mr-1 h-3 w-3" />
                )}
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabSwitch({
  tab,
  onTabChange,
}: {
  tab: 'ai' | 'raw';
  onTabChange: (t: 'ai' | 'raw') => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
      <button
        type="button"
        onClick={() => onTabChange('ai')}
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
          tab === 'ai'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Sparkles className="h-2.5 w-2.5" />
        AI refine
      </button>
      <button
        type="button"
        onClick={() => onTabChange('raw')}
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
          tab === 'raw'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Pencil className="h-2.5 w-2.5" />
        Edit raw
      </button>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

type ReportShape = {
  opening?: string;
  wins_and_progress?: string;
  honest_feedback?: string;
  key_insight?: string;
  commitments?: string;
  report?: {
    progressSummary?: string;
    keyWins?: string[];
    challenges?: string[];
    patternObservations?: string;
    suggestedNextSteps?: string[];
  };
};

function extractSectionValue(
  contentJson: unknown,
  section: string,
): string | string[] {
  const c = (contentJson ?? {}) as ReportShape;
  const r = c.report ?? {};
  switch (section) {
    case 'progressSummary':
      return r.progressSummary ?? '';
    case 'patternObservations':
      return r.patternObservations ?? '';
    case 'keyWins':
      return r.keyWins ?? [];
    case 'challenges':
      return r.challenges ?? [];
    case 'suggestedNextSteps':
      return r.suggestedNextSteps ?? [];
    case 'opening':
      return c.opening ?? '';
    case 'wins_and_progress':
      return c.wins_and_progress ?? '';
    case 'honest_feedback':
      return c.honest_feedback ?? '';
    case 'key_insight':
      return c.key_insight ?? '';
    case 'commitments':
      return c.commitments ?? '';
    default:
      return '';
  }
}

function listToText(value: string | string[]): string {
  if (Array.isArray(value)) return value.join('\n');
  return value;
}
