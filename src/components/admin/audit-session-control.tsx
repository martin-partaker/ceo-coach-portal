'use client';

import { useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';
import { sessionWords, type SessionOverride } from '@/lib/audit/session-override';

/**
 * Which session is this recording? — said by the reviewer.
 *
 * The session number is inferred from dates and from what is said, and the
 * inference is sometimes wrong and sometimes not possible. The person reading
 * the audit usually knows. This is where she says so.
 *
 * It saves at once, and it does not re-run the audit: audits are produced
 * offline. What changes at once is what the screens claim — an audit run as
 * another session stops being shown as verdicts. The audit itself is replaced
 * the next time audits are generated.
 */

const NOT_NUMBERED = 'none';
const SESSIONS = Array.from({ length: 12 }, (_, i) => i + 1);

const LINK =
  'text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline ' +
  'disabled:pointer-events-none disabled:opacity-50';
const BUTTON =
  'inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background/60 px-3 ' +
  'text-xs font-medium transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50';
const FIELD =
  'h-8 rounded-md border border-border bg-background/70 px-2 text-sm outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring/50';

export function SessionControl({
  auditId,
  auditedAs,
  override,
}: {
  auditId: string;
  /** The session the audit on file was run as; null if it was not placed. */
  auditedAs: number | null;
  override: SessionOverride | null;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const current = override ? override.sessionNo : auditedAs;
  const [value, setValue] = useState(current === null ? '' : String(current));
  const [note, setNote] = useState(override?.note ?? '');

  const refresh = () => {
    setOpen(false);
    void utils.audit.byId.invalidate({ auditId });
    void utils.audit.list.invalidate();
    void utils.audit.cohort.invalidate();
  };
  const set = trpc.audit.setSession.useMutation({ onSuccess: refresh });
  const clear = trpc.audit.clearSession.useMutation({ onSuccess: refresh });
  const busy = set.isPending || clear.isPending;
  const error = set.error ?? clear.error;

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {override ? (
          <span className="text-xs text-muted-foreground">
            {sessionWords(override.sessionNo)} — set by {override.setByName} on{' '}
            {new Date(override.setAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
            {override.note ? ` — “${override.note}”` : ''}
          </span>
        ) : null}
        <button type="button" onClick={() => setOpen(true)} className={cn(LINK, 'inline-flex items-center gap-1')}>
          <Pencil className="h-3 w-3" />
          {override ? 'Change' : 'Not the right session? Set it'}
        </button>
        {override ? (
          <button type="button" disabled={busy} onClick={() => clear.mutate({ auditId })} className={LINK}>
            Back to automatic
          </button>
        ) : null}
        {busy ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : null}
        {error ? <span className="text-xs text-destructive">Not saved: {error.message}</span> : null}
      </div>
    );
  }

  return (
    <div className="mt-3 max-w-3xl rounded-md border border-border bg-muted/30 p-3">
      <p className="text-sm font-medium">Which session is this recording?</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Saved at once. The audit is not re-run on the spot: it is replaced the next time
        audits are generated, and until then an audit run as another session is not shown.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          aria-label="Session"
          className={FIELD}
        >
          <option value="" disabled>
            Choose…
          </option>
          {SESSIONS.map((n) => (
            <option key={n} value={String(n)}>
              Session {n}
            </option>
          ))}
          <option value={NOT_NUMBERED}>Not a numbered session (support call, group call…)</option>
        </select>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          disabled={busy}
          placeholder="How do you know? (optional)"
          className={cn(FIELD, 'w-full sm:flex-1')}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || value === ''}
            onClick={() =>
              set.mutate({
                auditId,
                sessionNo: value === NOT_NUMBERED ? null : Number.parseInt(value, 10),
                note: note.trim() || null,
              })
            }
            className={BUTTON}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Save
          </button>
          <button type="button" disabled={busy} onClick={() => setOpen(false)} className={LINK}>
            Cancel
          </button>
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">Not saved: {error.message}</p> : null}
    </div>
  );
}
