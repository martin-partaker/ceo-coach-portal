'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface KpiRow {
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
  note?: string;
}

const SAVE_DEBOUNCE_MS = 800;

/**
 * Inline KPI editor for the Monthly Goals / Reflection / Action Items
 * stack in the cycle workspace. Each row is label + value + optional
 * trend + optional note. The whole list is sent back to
 * `roster.updateCycle` on each (debounced) save — partial diffs aren't
 * worth the complexity here since cycle KPI lists are short.
 *
 * Empty rows are dropped before save so an "Add KPI" left blank
 * doesn't pollute the prompt.
 */
export function CycleKpiEditor({
  cycleId,
  initialKpis,
}: {
  cycleId: string;
  initialKpis: KpiRow[];
}) {
  const utils = trpc.useUtils();
  const [rows, setRows] = useState<KpiRow[]>(initialKpis);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSavedRef = useRef<string>(JSON.stringify(initialKpis));

  // Re-seed when the upstream value changes (cycle switch, server
  // re-fetch). We compare JSON to avoid replacing the user's in-flight
  // edits with what we already saved.
  useEffect(() => {
    const serialised = JSON.stringify(initialKpis);
    if (serialised !== lastSavedRef.current) {
      setRows(initialKpis);
      lastSavedRef.current = serialised;
    }
  }, [initialKpis]);

  const update = trpc.roster.updateCycle.useMutation({
    onSuccess: () => {
      lastSavedRef.current = JSON.stringify(cleanRows(rows));
      setSavedAt(Date.now());
      setError(null);
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  // Debounced save on any row change. We drop blank rows before
  // sending so a half-typed Add KPI doesn't fail the zod min(1) on
  // label/value.
  useEffect(() => {
    const cleaned = cleanRows(rows);
    const next = JSON.stringify(cleaned);
    if (next === lastSavedRef.current) return;
    const t = setTimeout(() => {
      update.mutate({ cycleId, kpis: cleaned });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cycleId]);

  const dirty = JSON.stringify(cleanRows(rows)) !== lastSavedRef.current;
  const showSaved = savedAt && Date.now() - savedAt < 4000 && !dirty;

  function setRow(i: number, patch: Partial<KpiRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { label: '', value: '' }]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <div className="grid gap-2">
      {rows.length === 0 ? (
        <p className="px-1 text-[11px] italic text-muted-foreground">
          No KPIs logged for this cycle yet — add a metric to start tracking.
        </p>
      ) : (
        <div className="grid gap-1.5">
          {rows.map((row, i) => (
            <div
              key={i}
              className="grid items-center gap-2 rounded-md border border-border bg-muted/10 px-2 py-1.5"
              style={{ gridTemplateColumns: '160px 1fr 88px 1fr 28px' }}
            >
              <Input
                value={row.label}
                onChange={(e) => setRow(i, { label: e.target.value })}
                placeholder="Label (e.g. Revenue)"
                className="h-7 text-xs"
              />
              <Input
                value={row.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="Value (e.g. $5.2M)"
                className="h-7 text-xs"
              />
              <Select
                value={row.trend ?? 'none'}
                onValueChange={(v) =>
                  setRow(i, {
                    trend:
                      v === 'none'
                        ? undefined
                        : (v as 'up' | 'down' | 'flat'),
                  })
                }
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder="Trend" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs">
                    no trend
                  </SelectItem>
                  <SelectItem value="up" className="text-xs">
                    <span className="inline-flex items-center gap-1">
                      <ArrowUp className="h-3 w-3 text-emerald-600" /> up
                    </span>
                  </SelectItem>
                  <SelectItem value="down" className="text-xs">
                    <span className="inline-flex items-center gap-1">
                      <ArrowDown className="h-3 w-3 text-destructive" /> down
                    </span>
                  </SelectItem>
                  <SelectItem value="flat" className="text-xs">
                    <span className="inline-flex items-center gap-1">
                      <ArrowRight className="h-3 w-3 text-muted-foreground" /> flat
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={row.note ?? ''}
                onChange={(e) => setRow(i, { note: e.target.value })}
                placeholder="Note (optional)"
                className="h-7 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeRow(i)}
                aria-label="Remove KPI"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 px-1 text-[10px] text-muted-foreground">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 border-dashed px-2 text-[11px] text-muted-foreground"
          onClick={addRow}
        >
          <Plus className="mr-1 h-3 w-3" /> Add KPI
        </Button>
        <span
          className={cn(
            'inline-flex items-center gap-1',
            error && 'text-destructive',
          )}
        >
          {update.isPending ? (
            <>
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> saving…
            </>
          ) : dirty ? (
            <span>unsaved</span>
          ) : showSaved ? (
            <>
              <Check className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" />{' '}
              saved
            </>
          ) : null}
          {error && <span>{error}</span>}
        </span>
      </div>
    </div>
  );
}

function cleanRows(rows: KpiRow[]): KpiRow[] {
  return rows
    .map((r) => ({
      label: r.label.trim(),
      value: r.value.trim(),
      trend: r.trend,
      note: r.note?.trim() || undefined,
    }))
    .filter((r) => r.label && r.value);
}
