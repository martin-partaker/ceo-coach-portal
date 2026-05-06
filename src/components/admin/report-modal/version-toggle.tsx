'use client';

import { Sparkles, Wand2, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Three-way toggle: v1 (legacy single-shot) · v2 first draft · v2 final.
 *
 * Each option is enabled only if that version exists; the rest grey
 * out with a helpful tooltip. Used in the modal header.
 */

export type VersionKey = 'v1' | 'v2-first' | 'v2-final';

export function VersionToggle({
  value,
  onChange,
  has,
}: {
  value: VersionKey;
  onChange: (v: VersionKey) => void;
  has: { v1: boolean; v2First: boolean; v2Final: boolean };
}) {
  const options: Array<{
    key: VersionKey;
    label: string;
    sublabel: string;
    icon: React.ReactNode;
    enabled: boolean;
    tooltip: string;
  }> = [
    {
      key: 'v1',
      label: 'v1',
      sublabel: 'legacy',
      icon: <FileText className="h-3 w-3" />,
      enabled: has.v1,
      tooltip: has.v1
        ? 'The previous single-shot generator. Kept for comparison.'
        : 'No v1 report has been generated for this cycle.',
    },
    {
      key: 'v2-first',
      label: 'v2',
      sublabel: 'first draft',
      icon: <Wand2 className="h-3 w-3" />,
      enabled: has.v2First,
      tooltip: has.v2First
        ? 'The first v2 draft, before the rubric critic ran any revisions.'
        : 'No first draft saved yet — generate v2 to see it.',
    },
    {
      key: 'v2-final',
      label: 'v2',
      sublabel: 'polished',
      icon: <Sparkles className="h-3 w-3" />,
      enabled: has.v2Final,
      tooltip: has.v2Final
        ? 'The final v2 report, after rubric-driven revisions.'
        : 'Generate v2 to see this.',
    },
  ];

  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-md border border-border bg-muted/30 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => o.enabled && onChange(o.key)}
          disabled={!o.enabled}
          className={cn(
            'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            !o.enabled && 'cursor-not-allowed opacity-40',
            o.enabled && value !== o.key && 'text-muted-foreground hover:bg-background hover:text-foreground',
            value === o.key && 'bg-background text-foreground shadow-sm',
          )}
          title={o.tooltip}
        >
          {o.icon}
          <span>{o.label}</span>
          <span className="opacity-60">· {o.sublabel}</span>
        </button>
      ))}
    </div>
  );
}
