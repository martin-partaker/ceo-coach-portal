import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type Confidence = 'confirmed' | 'probable' | 'undetermined' | string;

/**
 * The session-number confidence, always visible.
 *
 * This is not a caveat tucked away in a tooltip. Lauren's own account of the
 * current process is that she opens the recording to work out who was in it
 * and which session it was — so showing how sure we are IS the feature. A
 * verdict against the wrong outline is not a weaker audit, it is a void one.
 */
export function ConfidenceBadge({ value }: { value: Confidence }) {
  const style =
    value === 'confirmed'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : value === 'probable'
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : 'border-zinc-300 bg-zinc-100 text-zinc-700';
  const label =
    value === 'confirmed'
      ? 'Session 1 — confirmed'
      : value === 'probable'
        ? 'Session 1 — inferred'
        : 'Session not determined';
  return (
    <Badge variant="outline" className={cn('font-medium', style)}>
      {label}
    </Badge>
  );
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
