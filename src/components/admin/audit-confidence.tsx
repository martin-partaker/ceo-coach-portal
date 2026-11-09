import { cn } from '@/lib/utils';

/**
 * The visual language for the audit screens, in one place.
 *
 * Everything here is built from alpha tints (`/10`, `/15`) over the app's own
 * `bg-card`, plus a solid 500-weight accent for the edge and the label. An
 * alpha tint composites over whatever is behind it, so the same class reads
 * correctly in light and dark without a second palette to keep in step. The
 * first version of these screens used fixed light tints — `bg-rose-50`,
 * `bg-emerald-50` — which turned into flat washed-out grey on the dark theme
 * and made the badges white-on-white.
 *
 * Verdict is carried by a LEFT EDGE, not by a filled background. A fully
 * tinted card competes with the text it contains, and the text is the point:
 * these screens exist to be read closely, not scanned for colour.
 */

export type Confidence = 'confirmed' | 'probable' | 'undetermined' | string;

type Tone = {
  /** Left accent on a card. */
  edge: string;
  /** Pill: tint + readable text in both themes. */
  pill: string;
  label: string;
};

export const VERDICT_TONE: Record<string, Tone> = {
  concern: {
    edge: 'border-l-rose-500',
    pill: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-inset ring-rose-500/30',
    label: 'to raise',
  },
  review: {
    edge: 'border-l-amber-500',
    pill: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-500/30',
    label: 'to review',
  },
  ok: {
    edge: 'border-l-emerald-500',
    pill: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-500/30',
    label: 'clear',
  },
  /**
   * Deliberately NOT green. An unassessed criterion is a hole in what we could
   * look at, so it gets its own neutral edge and its own label rather than
   * sliding in among the clear ones.
   *
   * No `border-dashed` here: that sets the style on all four sides, and the
   * Card already draws a 1px border all round, so it would dash the whole
   * outline instead of the left edge.
   */
  notAssessed: {
    edge: 'border-l-zinc-400 dark:border-l-zinc-500',
    pill: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 ring-1 ring-inset ring-zinc-500/30',
    label: 'not assessed',
  },
};

export const CONFIDENCE_TONE: Record<string, Tone & { text: string }> = {
  confirmed: {
    edge: 'border-l-emerald-500',
    pill: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-500/30',
    label: 'confirmed',
    text: 'Session 1 — confirmed',
  },
  probable: {
    edge: 'border-l-amber-500',
    pill: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-500/30',
    label: 'inferred',
    text: 'Session 1 — inferred',
  },
  undetermined: {
    edge: 'border-l-zinc-400 dark:border-l-zinc-500',
    pill: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 ring-1 ring-inset ring-zinc-500/30',
    label: 'undetermined',
    text: 'Session not determined',
  },
};

export function Pill({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The session-number confidence, always visible.
 *
 * Not a caveat in a tooltip. Lauren's account of the current process is that
 * she opens the recording to work out which session it was — so showing how
 * sure we are IS the feature. A verdict against the wrong outline is not a
 * weaker audit, it is a void one.
 */
export function ConfidenceBadge({ value }: { value: Confidence }) {
  const tone = CONFIDENCE_TONE[value] ?? CONFIDENCE_TONE.undetermined;
  return <Pill className={tone.pill}>{tone.text}</Pill>;
}

export function formatClock(sec: number | null): string | null {
  if (sec === null || Number.isNaN(sec)) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
