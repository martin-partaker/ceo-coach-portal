'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { ArrowRight, Plus, Minus, Equal } from 'lucide-react';
import type { DocumentReportShape } from './document-renderer';

/**
 * Section-level diff between v2 first draft and v2 final.
 *
 * For prose fields: side-by-side cards (red-tinted "before" / green
 * "after") shown only when the text differs. Identical sections render
 * as a collapsed "no change" strip.
 *
 * For list fields (keyWins, challenges, suggestedNextSteps): compute a
 * keyed diff — items in both, items removed, items added.
 */

type Props = {
  first: DocumentReportShape;
  final: DocumentReportShape;
};

const PROSE_FIELDS = [
  { key: 'progressSummary' as const, label: 'Progress Summary' },
  { key: 'patternObservations' as const, label: 'Pattern Observations' },
];

const LIST_FIELDS = [
  { key: 'keyWins' as const, label: 'Key Wins' },
  { key: 'challenges' as const, label: 'Challenges & Patterns' },
  { key: 'suggestedNextSteps' as const, label: 'Recommended Next Steps' },
];

export function DiffView({ first, final }: Props) {
  const f = first.report ?? {};
  const fin = final.report ?? {};

  const hasAnyDiff = useMemo(() => {
    for (const { key } of PROSE_FIELDS) {
      if ((f[key] ?? '').trim() !== (fin[key] ?? '').trim()) return true;
    }
    for (const { key } of LIST_FIELDS) {
      if (!arraysEqual(f[key] ?? [], fin[key] ?? [])) return true;
    }
    if ((f.goalSummary?.flag ?? '') !== (fin.goalSummary?.flag ?? '')) return true;
    return false;
  }, [f, fin]);

  if (!hasAnyDiff) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-6 text-center text-sm text-emerald-700 dark:text-emerald-400">
        First draft passed the rubric on the first try — no revisions
        needed.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-[12px] text-blue-800 dark:text-blue-300">
        <span className="font-semibold">What changed:</span> the rubric
        critic flagged sections below as weak; the drafter rewrote them.
        First draft on the left, polished version on the right.
      </div>

      {PROSE_FIELDS.map(({ key, label }) => {
        const a = (f[key] ?? '').trim();
        const b = (fin[key] ?? '').trim();
        if (a === b) return <NoChangeStrip key={key} label={label} />;
        return <ProseDiff key={key} label={label} before={a} after={b} />;
      })}

      {LIST_FIELDS.map(({ key, label }) => {
        const a = f[key] ?? [];
        const b = fin[key] ?? [];
        if (arraysEqual(a, b)) return <NoChangeStrip key={key} label={label} />;
        return <ListDiff key={key} label={label} before={a} after={b} />;
      })}
    </div>
  );
}

function NoChangeStrip({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
      <Equal className="h-3 w-3" />
      <span>
        <span className="font-medium">{label}:</span> unchanged
      </span>
    </div>
  );
}

function ProseDiff({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] font-semibold">
        <span>{label}</span>
        <span className="text-muted-foreground">
          first draft <ArrowRight className="inline h-2.5 w-2.5" /> polished
        </span>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="bg-red-500/[0.03] p-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-red-700/70 dark:text-red-300/70">
            First draft
          </p>
          <div className="text-[12px] leading-relaxed">
            <Markdown text={before || '(empty)'} size="sm" />
          </div>
        </div>
        <div className="bg-emerald-500/[0.03] p-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700/70 dark:text-emerald-300/70">
            Polished
          </p>
          <div className="text-[12px] leading-relaxed">
            <Markdown text={after || '(empty)'} size="sm" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ListDiff({
  label,
  before,
  after,
}: {
  label: string;
  before: string[];
  after: string[];
}) {
  const beforeSet = new Set(before.map(normalize));
  const afterSet = new Set(after.map(normalize));
  const removed = before.filter((b) => !afterSet.has(normalize(b)));
  const added = after.filter((a) => !beforeSet.has(normalize(a)));
  const kept = after.filter((a) => beforeSet.has(normalize(a)));

  return (
    <div className="rounded-md border border-border">
      <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] font-semibold">
        {label}{' '}
        <span className="text-muted-foreground">
          ({added.length} added · {removed.length} removed · {kept.length} kept)
        </span>
      </div>
      <ul className="divide-y divide-border">
        {removed.map((r, i) => (
          <DiffRow key={`r-${i}`} kind="removed" text={r} />
        ))}
        {added.map((a, i) => (
          <DiffRow key={`a-${i}`} kind="added" text={a} />
        ))}
        {kept.map((k, i) => (
          <DiffRow key={`k-${i}`} kind="kept" text={k} />
        ))}
      </ul>
    </div>
  );
}

function DiffRow({
  kind,
  text,
}: {
  kind: 'added' | 'removed' | 'kept';
  text: string;
}) {
  const styles = {
    added: 'bg-emerald-500/[0.05] text-emerald-800 dark:text-emerald-300',
    removed: 'bg-red-500/[0.05] text-red-700 line-through dark:text-red-300',
    kept: 'text-muted-foreground',
  }[kind];
  const Icon = kind === 'added' ? Plus : kind === 'removed' ? Minus : Equal;
  return (
    <li className={cn('flex items-start gap-2 px-3 py-1.5 text-[12px] leading-relaxed', styles)}>
      <Icon className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="flex-1">
        <MarkdownInline text={text} />
      </span>
    </li>
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normalize(a[i]) !== normalize(b[i])) return false;
  }
  return true;
}
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}
