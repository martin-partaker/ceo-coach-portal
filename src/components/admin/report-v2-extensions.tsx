'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Info,
  Loader2,
  MessageSquare,
  Pin,
  PinOff,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import type { RubricItemId } from '@/lib/prompts/v2/schemas';

/**
 * v2 UI affordances:
 *  - V2GenerateButton    : footer button that runs the full A→B→C→D pipeline
 *  - CritiqueStrip       : per-rubric-item pass/fail at the top of the report
 *  - CoachReviewFlagsBanner : warning callouts the model wants the coach to see
 *  - RefineChatButton    : per-section "Refine" affordance + sheet
 *  - PinParagraphButton  : pin a paragraph so it's preserved across regenerations
 */

// ── V2GenerateButton ─────────────────────────────────────────────────

export function V2GenerateButton({
  cycleId,
  onComplete,
}: {
  cycleId: string;
  onComplete?: (jobId: string) => void;
}) {
  const utils = trpc.useUtils();
  const generate = trpc.reports.generateV2.useMutation({
    onSuccess: async (res) => {
      await Promise.all([
        utils.reports.getActiveJob.invalidate({ cycleId }),
        utils.reports.listActiveJobs.invalidate(),
        utils.reports.getForCycle.invalidate({ cycleId }),
        utils.reports.getFacts.invalidate({ cycleId }),
      ]);
      onComplete?.(res.jobId);
    },
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        onClick={() => generate.mutate({ cycleId })}
        disabled={generate.isPending}
        title="Run the full v2 pipeline: extract facts → match patterns → draft → critique → revise"
      >
        {generate.isPending ? (
          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="mr-1.5 h-3 w-3" />
        )}
        Generate v2
      </Button>
      {generate.error && (
        <p className="max-w-xs text-right text-[11px] text-destructive">
          {generate.error.message}
        </p>
      )}
    </div>
  );
}

// ── CritiqueStrip ────────────────────────────────────────────────────

const RUBRIC_LABELS: Record<RubricItemId, string> = {
  goalCascade: 'Goal cascade',
  coachReviewFlag: 'Coach flag',
  quantifiedEffort: 'Effort quantified',
  stakeholderFeedback: 'Stakeholder voice',
  constraintNamed: 'Constraint named',
  specificNumbers: 'Specific numbers',
  counterFactualNextSteps: 'Counter-factual',
  emotionalEventsHandled: 'Emotional context',
  crossCycleDelta: 'Cross-cycle delta',
};

export function CritiqueStrip({ reportId }: { reportId: string }) {
  const critique = trpc.reports.getCritique.useQuery({ reportId });
  if (critique.isLoading || !critique.data) return null;

  const rubric = critique.data.rubricJson as {
    pass: boolean;
    items?: Array<{ id: string; pass: boolean; reason: string }>;
    topFix?: string | null;
  };
  const items = rubric.items ?? [];
  const passed = critique.data.pass;
  const topFix = rubric.topFix;
  const failedCount = items.filter((i) => !i.pass).length;

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2',
        passed
          ? 'border-green-500/30 bg-green-500/5'
          : 'border-amber-500/30 bg-amber-500/5',
      )}
    >
      <div className="flex items-center gap-2">
        {passed ? (
          <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        )}
        <p className="text-xs font-medium">
          Rubric: {passed ? 'all 9 checks pass' : `${failedCount} of ${items.length} need work`}
        </p>
        <span className="ml-auto text-[10px] text-muted-foreground">
          v2 critic
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {items.map((it) => (
          <span
            key={it.id}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px]',
              it.pass
                ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
            )}
            title={it.reason}
          >
            {it.pass ? '✓' : '×'} {RUBRIC_LABELS[it.id as RubricItemId] ?? it.id}
          </span>
        ))}
      </div>
      {!passed && topFix && (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
          <span className="font-semibold">Top fix:</span> {topFix}
        </p>
      )}
    </div>
  );
}

// ── CoachReviewFlagsBanner ───────────────────────────────────────────

export function CoachReviewFlagsBanner({
  flags,
}: {
  flags?: Array<{ title: string; detail: string; urgency?: 'info' | 'attention' | 'urgent' }>;
}) {
  if (!flags || flags.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {flags.map((f, i) => {
        const urgency = f.urgency ?? 'attention';
        const Icon = urgency === 'urgent' ? AlertCircle : urgency === 'info' ? Info : AlertTriangle;
        const styles = {
          info: 'border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300',
          attention:
            'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300',
          urgent:
            'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
        }[urgency];
        return (
          <div
            key={i}
            className={cn('flex items-start gap-2 rounded-md border px-3 py-2', styles)}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="text-xs leading-relaxed">
              <p className="font-semibold">Flag for coach review: {f.title}</p>
              <p className="opacity-90">{f.detail}</p>
            </div>
          </div>
        );
      })}
      <p className="text-[10px] text-muted-foreground">
        These flags are visible to the coach only — they are never sent to the CEO.
      </p>
    </div>
  );
}

// ── RefineChatButton + Sheet ─────────────────────────────────────────

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

export function RefineChatButton({
  reportId,
  section,
}: {
  reportId: string;
  section: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        aria-label={`Refine ${section}`}
        title="Refine in chat (v2)"
      >
        <MessageSquare className="h-3 w-3" />
      </Button>
      {open && (
        <RefineChatSheet
          reportId={reportId}
          section={section}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

function RefineChatSheet({
  reportId,
  section,
  open,
  onOpenChange,
}: {
  reportId: string;
  section: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const refinements = trpc.reports.listRefinements.useQuery(
    { reportId },
    { enabled: open },
  );
  const pins = trpc.reports.listPins.useQuery({ reportId }, { enabled: open });
  const refine = trpc.reports.refineSectionV2.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.listRefinements.invalidate({ reportId }),
        utils.reports.getForCycle.invalidate(),
      ]);
      setMessage('');
    },
  });

  const [message, setMessage] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionTurns = (refinements.data?.[section] ?? []) as Array<{
    id: string;
    role: string;
    content: string;
    sectionSnapshot: string | null;
    createdAt: string | Date;
  }>;
  const sectionPins = (pins.data ?? []).filter((p) => p.section === section);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sectionTurns.length]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Refine — {REFINABLE_LABELS[section] ?? section}
          </SheetTitle>
          <SheetDescription>
            Iterate on this section in chat. Each turn rewrites only this
            section using the typed CycleFacts as ground truth.
          </SheetDescription>
        </SheetHeader>

        {sectionPins.length > 0 && (
          <div className="border-b border-border bg-muted/20 px-4 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Pinned in this section
            </p>
            <ul className="mt-1 space-y-1">
              {sectionPins.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start gap-1.5 rounded bg-background px-2 py-1 text-[11px] leading-snug"
                >
                  <Pin className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                  <span className="line-clamp-2 flex-1">{p.paragraphText}</span>
                  <UnpinButton pinId={p.id} reportId={reportId} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {refinements.isLoading && (
            <div className="flex h-16 items-center justify-center">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            </div>
          )}
          {!refinements.isLoading && sectionTurns.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              No refinements yet. Send a message to rewrite this section —
              e.g. "make this more specific to the COO hire" or "soften the
              personal note".
            </p>
          )}
          {sectionTurns.map((t) => (
            <div
              key={t.id}
              className={cn(
                'rounded-md border px-3 py-2 text-[12px] leading-relaxed',
                t.role === 'user'
                  ? 'border-blue-500/20 bg-blue-500/5'
                  : 'border-border bg-muted/20',
              )}
            >
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t.role === 'user' ? 'You' : 'AI'}
              </p>
              <p className="whitespace-pre-wrap">{t.content}</p>
            </div>
          ))}
          {refine.error && (
            <p className="text-[11px] text-destructive">{refine.error.message}</p>
          )}
        </div>

        <div className="border-t border-border bg-background px-4 py-3">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What should change about this section?"
            rows={3}
            className="text-[12px]"
            disabled={refine.isPending}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground">
              The whole report stays untouched — only this section is
              regenerated.
            </p>
            <Button
              size="sm"
              onClick={() =>
                refine.mutate({
                  reportId,
                  section: section as Parameters<typeof refine.mutate>[0]['section'],
                  message: message.trim(),
                })
              }
              disabled={refine.isPending || !message.trim()}
            >
              {refine.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Send className="mr-1 h-3 w-3" />
              )}
              Send
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function UnpinButton({ pinId, reportId }: { pinId: string; reportId: string }) {
  const utils = trpc.useUtils();
  const unpin = trpc.reports.unpinParagraph.useMutation({
    onSuccess: () => utils.reports.listPins.invalidate({ reportId }),
  });
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-5 w-5 shrink-0 p-0 text-muted-foreground hover:text-destructive"
      onClick={() => unpin.mutate({ pinId })}
      disabled={unpin.isPending}
      aria-label="Unpin"
    >
      <X className="h-3 w-3" />
    </Button>
  );
}

// ── PinParagraphButton ───────────────────────────────────────────────

export function PinParagraphButton({
  reportId,
  section,
  text,
}: {
  reportId: string;
  section: string;
  text: string;
}) {
  const utils = trpc.useUtils();
  const pins = trpc.reports.listPins.useQuery({ reportId });
  const isPinned = (pins.data ?? []).some(
    (p) => p.section === section && p.paragraphText.trim() === text.trim(),
  );
  const pinned = (pins.data ?? []).find(
    (p) => p.section === section && p.paragraphText.trim() === text.trim(),
  );

  const pin = trpc.reports.pinParagraph.useMutation({
    onSuccess: () => utils.reports.listPins.invalidate({ reportId }),
  });
  const unpin = trpc.reports.unpinParagraph.useMutation({
    onSuccess: () => utils.reports.listPins.invalidate({ reportId }),
  });

  const busy = pin.isPending || unpin.isPending;
  const Icon = isPinned ? PinOff : Pin;

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        'h-6 w-6 p-0 text-muted-foreground hover:text-foreground',
        isPinned && 'text-amber-500 hover:text-amber-600',
      )}
      onClick={() => {
        if (busy) return;
        if (isPinned && pinned) unpin.mutate({ pinId: pinned.id });
        else pin.mutate({ reportId, section: section as Parameters<typeof pin.mutate>[0]['section'], paragraphText: text });
      }}
      disabled={busy}
      title={isPinned ? 'Unpin from regenerations' : 'Pin so it survives regenerations'}
      aria-label={isPinned ? 'Unpin' : 'Pin'}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
    </Button>
  );
}

// ── GoalCascadeCard ──────────────────────────────────────────────────

export function GoalCascadeCard({
  goal,
}: {
  goal: {
    tenX?: string;
    ninetyDay?: string | null;
    thirtyDay?: string | null;
    flag?: string | null;
  };
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/15 px-3.5 py-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Goal cascade (this cycle)
      </p>
      <div className="space-y-1.5 text-[12px] leading-relaxed">
        {goal.tenX && (
          <p>
            <span className="font-semibold">10x:</span> {goal.tenX}
          </p>
        )}
        {goal.ninetyDay && (
          <p>
            <span className="font-semibold">90-day:</span> {goal.ninetyDay}
          </p>
        )}
        {goal.thirtyDay && (
          <p>
            <span className="font-semibold">30-day:</span> {goal.thirtyDay}
          </p>
        )}
      </div>
      {goal.flag && (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <span className="font-semibold">⚑ Flag:</span> {goal.flag}
        </div>
      )}
    </div>
  );
}

// ── CycleFactsInspector (source attribution) ─────────────────────────

export function CycleFactsInspector({ cycleId }: { cycleId: string }) {
  const [open, setOpen] = useState(false);
  const facts = trpc.reports.getFacts.useQuery({ cycleId }, { enabled: open });

  const factsJson = (facts.data?.factsJson ?? null) as
    | {
        evidenceClaims?: Array<{
          claim: string;
          source: { kind: string; locator: string; quote: string };
          category: string;
        }>;
        coachReviewFlags?: Array<{ title: string; detail: string; urgency?: string }>;
      }
    | null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        title="Inspect typed CycleFacts (Stage A)"
      >
        Facts
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>CycleFacts — source attribution</SheetTitle>
            <SheetDescription>
              The typed extraction the v2 pipeline produced from this cycle's
              raw inputs. Every win/challenge in the report should ground in
              one of these claims.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {facts.isLoading && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            {!facts.isLoading && !factsJson && (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                No CycleFacts yet — run "Generate v2" first.
              </p>
            )}
            {factsJson?.coachReviewFlags && factsJson.coachReviewFlags.length > 0 && (
              <div className="mb-3">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Coach review flags
                </p>
                <CoachReviewFlagsBanner
                  flags={factsJson.coachReviewFlags as Array<{
                    title: string;
                    detail: string;
                    urgency?: 'info' | 'attention' | 'urgent';
                  }>}
                />
              </div>
            )}
            {factsJson?.evidenceClaims && factsJson.evidenceClaims.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Evidence claims ({factsJson.evidenceClaims.length})
                </p>
                {factsJson.evidenceClaims.map((c, i) => (
                  <div
                    key={i}
                    className="rounded-md border border-border bg-muted/20 px-3 py-2"
                  >
                    <p className="text-[12px]">{c.claim}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      <span className="font-medium">{c.category}</span>
                      {' · '}
                      <span>
                        {c.source.kind} · {c.source.locator}
                      </span>
                    </p>
                    <p className="mt-1 rounded bg-background px-2 py-1 text-[11px] italic text-foreground/80">
                      "{c.source.quote}"
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
