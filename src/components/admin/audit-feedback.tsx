'use client';

import { useState } from 'react';
import { Check, HelpCircle, Loader2, X } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';
import {
  FEEDBACK_REASONS,
  type FeedbackReason,
  type FeedbackVerdict,
} from '@/lib/audit/contract';

/**
 * Agree / Disagree on one finding.
 *
 * It sits on every finding because the two criteria that turned out to be
 * wrong were reported to us in conversation, weeks after they started firing.
 * The reviewer is already reading the finding; the cheapest moment to learn it
 * is wrong is one click away from where she read it.
 *
 * Everything saves on the click. There is no form to submit and nothing to
 * lose by moving on, which matters across thirty sessions of twenty findings.
 * Only the note has a button, because a note is typed.
 *
 * A disagreement asks why, with four fixed reasons, because "disagree" alone
 * does not say whether to fix the criterion or the quote.
 */

export type FeedbackEntry = {
  verdict: string;
  reason: string | null;
  note: string | null;
  coachName: string;
  updatedAt: Date;
};

export type FindingFeedbackData = {
  mine: FeedbackEntry | null;
  others: FeedbackEntry[];
};

const VERDICTS: {
  value: FeedbackVerdict;
  label: string;
  Icon: typeof Check;
  on: string;
}[] = [
  {
    value: 'agree',
    label: 'Agree',
    Icon: Check,
    on: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200',
  },
  {
    value: 'disagree',
    label: 'Disagree',
    Icon: X,
    on: 'border-rose-500/60 bg-rose-500/15 text-rose-800 dark:text-rose-200',
  },
  {
    value: 'unsure',
    label: 'Not sure',
    Icon: HelpCircle,
    on: 'border-zinc-500/60 bg-zinc-500/15 text-zinc-800 dark:text-zinc-200',
  },
];

const VERDICT_LABEL: Record<string, string> = {
  agree: 'Agree',
  disagree: 'Disagree',
  unsure: 'Not sure',
};

const REASON_LABEL: Record<FeedbackReason, string> = {
  false_finding: 'Not what happened',
  wrong_quote: 'Right finding, wrong quote',
  not_applicable: 'Does not apply to this session',
  wrong_severity: 'Wrong severity',
};

const CHIP =
  'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium ' +
  'transition-colors disabled:pointer-events-none disabled:opacity-50';
const CHIP_OFF =
  'border-border bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground';

export function FindingFeedback({
  auditId,
  findingId,
  findingStep,
  feedback,
}: {
  auditId: string;
  findingId: string;
  findingStep: string | null;
  feedback: FindingFeedbackData;
}) {
  const utils = trpc.useUtils();
  const mine = feedback.mine;
  const [note, setNote] = useState(mine?.note ?? '');
  const [noteOpen, setNoteOpen] = useState(Boolean(mine?.note));

  const refresh = () => {
    void utils.audit.byId.invalidate({ auditId });
    void utils.audit.list.invalidate();
  };
  const set = trpc.audit.setFeedback.useMutation({ onSuccess: refresh });
  const clear = trpc.audit.clearFeedback.useMutation({
    onSuccess: () => {
      setNote('');
      setNoteOpen(false);
      refresh();
    },
  });
  const busy = set.isPending || clear.isPending;
  const error = set.error ?? clear.error;

  const target = { auditId, findingId, findingStep };
  const save = (verdict: FeedbackVerdict, reason: FeedbackReason | null) =>
    set.mutate({ ...target, verdict, reason, note: note.trim() || null });

  const myReason = (mine?.verdict === 'disagree' ? mine.reason : null) as FeedbackReason | null;
  const noteDirty = (mine?.note ?? '') !== note.trim();

  return (
    <div className="mt-3 border-t border-border/70 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Your view</span>
        {VERDICTS.map(({ value, label, Icon, on }) => {
          const selected = mine?.verdict === value;
          return (
            <button
              key={value}
              type="button"
              disabled={busy}
              aria-pressed={selected}
              onClick={() => {
                if (!selected) save(value, value === 'disagree' ? myReason : null);
              }}
              className={cn(CHIP, selected ? on : CHIP_OFF)}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          );
        })}
        {busy ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : null}
        {mine && !busy ? (
          <>
            {!noteOpen ? (
              <button
                type="button"
                onClick={() => setNoteOpen(true)}
                className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Add a note
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => clear.mutate(target)}
              className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear
            </button>
          </>
        ) : null}
      </div>

      {mine?.verdict === 'disagree' ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Because</span>
          {FEEDBACK_REASONS.map((r) => {
            const selected = myReason === r;
            return (
              <button
                key={r}
                type="button"
                disabled={busy}
                aria-pressed={selected}
                onClick={() => save('disagree', selected ? null : r)}
                className={cn(
                  CHIP,
                  selected
                    ? 'border-rose-500/60 bg-rose-500/15 text-rose-800 dark:text-rose-200'
                    : CHIP_OFF,
                )}
              >
                {REASON_LABEL[r]}
              </button>
            );
          })}
        </div>
      ) : null}

      {mine && noteOpen ? (
        <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-start">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="What should it have said?"
            className="min-h-[2.75rem] w-full rounded-md border border-border bg-background/70 px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <button
            type="button"
            disabled={busy || !noteDirty}
            onClick={() => save(mine.verdict as FeedbackVerdict, myReason)}
            className={cn(CHIP, CHIP_OFF, 'h-8 shrink-0 px-3')}
          >
            {noteDirty ? 'Save note' : 'Saved'}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-destructive">Not saved: {error.message}</p>
      ) : null}

      {feedback.others.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {feedback.others.map((o, i) => (
            <li key={i} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">{o.coachName}</span>
              {': '}
              {VERDICT_LABEL[o.verdict] ?? o.verdict}
              {o.reason ? ` — ${REASON_LABEL[o.reason as FeedbackReason] ?? o.reason}` : ''}
              {o.note ? ` — “${o.note}”` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
