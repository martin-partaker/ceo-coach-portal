'use client';

import { Sparkles, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Two-way toggle: First draft (v1 single-shot) vs Polished (v2 agentic).
 *
 * The "v2 first draft" stage (Stage C output before the rubric critic
 * ran) is intentionally hidden from this primary toggle — it lives
 * inside the "Show what improved" diff view, not as a top-level tab.
 *
 * Each option is enabled only if that version exists; the disabled
 * one greys out with a helpful tooltip.
 */

export type VersionKey = 'v1' | 'v2-final';

export function VersionToggle({
  value,
  onChange,
  has,
}: {
  value: VersionKey;
  onChange: (v: VersionKey) => void;
  has: { v1: boolean; v2Final: boolean };
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
      label: 'First draft',
      sublabel: 'single-shot',
      icon: <FileText className="h-3 w-3" />,
      enabled: has.v1,
      tooltip: has.v1
        ? 'The original single-shot generator output. Kept for comparison.'
        : 'No first-draft (v1) report has been generated for this cycle.',
    },
    {
      key: 'v2-final',
      label: 'Polished',
      sublabel: 'agentic',
      icon: <Sparkles className="h-3 w-3" />,
      enabled: has.v2Final,
      tooltip: has.v2Final
        ? 'The polished v2 report — extracted facts, rubric-checked, refined.'
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
