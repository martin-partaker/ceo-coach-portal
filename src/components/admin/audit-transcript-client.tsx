'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, AlertTriangle, Video } from 'lucide-react';
import { trpc } from '@/lib/trpc/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatClock } from './audit-confidence';
import { parsePassageAnchor } from '@/lib/audit/contract';

/**
 * The transcript of one audited session, and the place a quote's minute
 * leads to.
 *
 * Zoom has no link that opens a recording at a given moment, so "take me to
 * that point in the call" cannot mean the video. It means this: the same
 * lines the audit quoted, highlighted, in their place, with what was said
 * before and after — and the time of every line beside it, for when the
 * reviewer does open the recording.
 *
 * The passage comes from the address (`#L12-15`), so a place in a transcript
 * can be bookmarked or sent to someone. The line numbers are the audit's own
 * evidence pointers; nothing is matched by text.
 */

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};
const readHash = () => window.location.hash;
const noHash = () => '';

type Line = { who: string | null; text: string; sec: number | null };

export function AuditTranscriptClient({ auditId }: { auditId: string }) {
  const { data, isLoading, error } = trpc.audit.transcript.useQuery({ auditId });
  const hash = useSyncExternalStore(subscribeToHash, readHash, noHash);
  const target = useMemo(() => parsePassageAnchor(hash), [hash]);

  const ready = data?.state === 'ok';
  const from = target?.from ?? null;
  useEffect(() => {
    if (!ready || from === null) return;
    document.getElementById(`L${from}`)?.scrollIntoView({ block: 'center' });
  }, [ready, from]);

  // Which finding each quoted passage belongs to, said once where it starts.
  const { quoted, captions } = useMemo(() => {
    const quoted = new Set<number>();
    const captions = new Map<number, string[]>();
    if (data?.state !== 'ok') return { quoted, captions };
    for (const c of data.cited) {
      for (let i = c.from; i <= c.to; i += 1) quoted.add(i);
      const label = c.step ? `${c.step} · ${c.name}` : c.name;
      const at = captions.get(c.from) ?? [];
      if (!at.includes(label)) at.push(label);
      captions.set(c.from, at);
    }
    return { quoted, captions };
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Not found.</p>;

  if (data.state !== 'ok') {
    return (
      <div className="space-y-4">
        <BackLink auditId={auditId} />
        <Card className="gap-0 border-l-4 border-l-amber-500 bg-amber-500/[0.08] p-4">
          <p className="flex gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>{data.reason}</span>
          </p>
        </Card>
      </div>
    );
  }

  const lines: Line[] = data.lines;
  const inRange = target !== null && target.from < lines.length;
  const targetClock = inRange ? formatClock(lines[target.from].sec) : null;

  return (
    <div className="space-y-6">
      <BackLink auditId={auditId} />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {data.title ?? 'Untitled recording'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Transcript
          {data.recordedAt
            ? ` · ${new Date(data.recordedAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}`
            : ''}
          {` · ${lines.length.toLocaleString('en-GB')} lines`}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {data.recordingUrl ? (
            <a
              href={data.recordingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <Video className="h-4 w-4" /> Open the recording in Zoom
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">
              No Zoom link is stored for this recording.
            </span>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-xs text-muted-foreground">
          {data.hasCueTimes
            ? 'The time beside each line is its moment in the recording. Zoom cannot open a ' +
              'recording at a given minute, so the link starts it from the beginning: move to ' +
              'the time shown here. Zoom may ask for the recording’s passcode, which is not kept here. '
            : 'No cue times were captured for this recording, so lines are numbered instead of timed. '}
          Shaded lines are the ones the audit quotes.
        </p>
      </div>

      {target !== null ? (
        <p className="text-sm">
          {inRange ? (
            <>
              Showing the passage quoted in the audit
              {targetClock ? (
                <>
                  {' '}
                  at <span className="font-mono tabular-nums">{targetClock}</span>
                </>
              ) : null}
              , highlighted below.
            </>
          ) : (
            'That passage is not in this transcript.'
          )}
        </p>
      ) : null}

      <Card className="gap-0 p-2 sm:p-4">
        {lines.map((l, i) => {
          if (l.text.trim() === '' && l.who === null) return null;
          const newTurn = i === 0 || lines[i - 1].who !== l.who;
          const hit = inRange && i >= target.from && i <= target.to;
          const clock = formatClock(l.sec);
          return (
            <div key={i}>
              {newTurn && l.who ? (
                <p className="mt-3 mb-0.5 pl-[4.75rem] text-xs font-semibold text-muted-foreground">
                  {l.who}
                </p>
              ) : null}
              <div
                id={`L${i}`}
                className={cn(
                  'grid scroll-mt-24 grid-cols-[4rem_1fr] gap-3 rounded-sm px-1 py-0.5',
                  hit
                    ? 'bg-amber-300/50 dark:bg-amber-400/25'
                    : quoted.has(i)
                      ? 'bg-muted/70'
                      : '',
                )}
              >
                <a
                  href={`#L${i}`}
                  title="Link to this line"
                  className="pt-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground hover:text-foreground"
                >
                  {clock ?? `#${i}`}
                </a>
                <span className="text-sm">
                  {l.text}
                  {captions.has(i) ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Quoted in the audit under: {captions.get(i)!.join('; ')}
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function BackLink({ auditId }: { auditId: string }) {
  return (
    <Link
      href={`/admin/audit/${auditId}`}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> The audit of this session
    </Link>
  );
}
