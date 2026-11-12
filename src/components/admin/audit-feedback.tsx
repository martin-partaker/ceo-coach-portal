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
import type {
  CarriedAnswer,
  ClaimChange,
  FindingFeedbackShape,
} from '@/lib/audit/feedback-carry';

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
 *
 * Audits are regenerated when a criterion is corrected, and an answer belongs
 * to the audit it was given on. So an answer from an earlier audit is carried
 * over here, in one of two ways. If the finding is still the same claim, it
 * is shown as her answer, marked as carried over. If the finding has changed,
 * it is shown as what she said then, with what changed, and the question is
 * put to her again: agreement with one claim is never shown as agreement with
 * another.
 */

export type FindingFeedbackData = FindingFeedbackShape;

const CHANGE_WORDS: Record<ClaimChange, string> = {
  verdict: 'its verdict is different',
  wording: 'it is worded differently',
  quote: 'it quotes a different passage',
  transcript: 'the transcript itself has changed',
  unknown: 'the earlier version can no longer be compared',
};

const WAS_WORDS: Record<string, string> = {
  concern: 'to raise',
  review: 'to review',
  ok: 'clear',
  notAssessed: 'not assessed',
};

/** "its verdict is different (it was “to review”) and it quotes a different passage" */
function whatChanged(c: CarriedAnswer): string {
  const parts = c.changes.map((k) =>
    k === 'verdict' && c.was
      ? `${CHANGE_WORDS.verdict} (it was “${WAS_WORDS[c.was] ?? c.was}”)`
      : CHANGE_WORDS[k],
  );
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

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
  // An earlier answer of hers, when she has said nothing on this audit.
  const carried = mine ? null : feedback.carried.mine;
  // It counts as her answer only while the finding is the same claim.
  const standing = carried?.stillStands ? carried : null;
  const asked = carried && !carried.stillStands ? carried : null;
  /** What the chips show: an answer given here, or one that still stands. */
  const shown = mine ?? standing;
  const [note, setNote] = useState(shown?.note ?? '');
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

  const myReason = (shown?.verdict === 'disagree' ? shown.reason : null) as FeedbackReason | null;
  const noteDirty = (mine?.note ?? '') !== note.trim();

  return (
    <div className="mt-3 border-t border-border/70 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Your view</span>
        {VERDICTS.map(({ value, label, Icon, on }) => {
          const selected = shown?.verdict === value;
          return (
            <button
              key={value}
              type="button"
              disabled={busy}
              aria-pressed={selected}
              // Clicking a carried-over answer saves it on this audit: it is
              // then hers here, and can take a note.
              title={selected && standing ? 'Confirm this answer on this version' : undefined}
              onClick={() => {
                if (!selected || standing) save(value, value === 'disagree' ? myReason : null);
              }}
              className={cn(CHIP, selected ? on : CHIP_OFF, selected && standing && 'border-dashed')}
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
        {carried && !busy ? (
          <button
            type="button"
            onClick={() => clear.mutate(target)}
            className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {standing ? 'Clear' : 'Dismiss'}
          </button>
        ) : null}
      </div>

      {standing ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Carried over from your answer on criteria {standing.fromCriteria}. The finding has
          not changed since, so it stands.
          {standing.note ? ` Your note: “${standing.note}”` : ''}
        </p>
      ) : null}

      {asked ? (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-1.5 text-xs">
          On an earlier version (criteria {asked.fromCriteria}) you answered{' '}
          <span className="font-medium">
            {VERDICT_LABEL[asked.verdict] ?? asked.verdict}
            {asked.reason ? ` — ${REASON_LABEL[asked.reason as FeedbackReason] ?? asked.reason}` : ''}
          </span>
          {asked.note ? ` — “${asked.note}”` : ''}. The finding has changed since:{' '}
          {whatChanged(asked)}. Your earlier answer is not applied to it — answer again if it
          still holds.
        </p>
      ) : null}

      {shown?.verdict === 'disagree' ? (
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

      {feedback.others.length + feedback.carried.others.length > 0 ? (
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
          {feedback.carried.others.map((o, i) => (
            <li key={`c${i}`} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">{o.coachName}</span>
              {': '}
              {VERDICT_LABEL[o.verdict] ?? o.verdict}
              {o.reason ? ` — ${REASON_LABEL[o.reason as FeedbackReason] ?? o.reason}` : ''}
              {o.note ? ` — “${o.note}”` : ''}
              {o.stillStands
                ? ` (on criteria ${o.fromCriteria}; the finding has not changed)`
                : ` (on criteria ${o.fromCriteria}; the finding has changed since: ${whatChanged(o)})`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
