'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  CornerDownRight,
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

interface KpiRowWithId extends KpiRow {
  /** Stable client-side id so React keys don't shift on insert/remove
   *  (which used to remount Radix Selects + lose focus). Not persisted. */
  _id: string;
}

const SAVE_DEBOUNCE_MS = 600;
const TREND_OPTIONS: Array<{ id: 'up' | 'down' | 'flat'; Icon: typeof ArrowUp; tone: string }> = [
  { id: 'up', Icon: ArrowUp, tone: 'text-emerald-600 dark:text-emerald-400' },
  { id: 'flat', Icon: ArrowRight, tone: 'text-muted-foreground' },
  { id: 'down', Icon: ArrowDown, tone: 'text-destructive' },
];

let _idCounter = 0;
const nextId = () => `kpi-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;

/**
 * Inline KPI editor for the cycle workspace.
 *
 * Each row is label + value + optional trend + optional note. The whole
 * list is sent back to roster.updateCycle on each (debounced) save —
 * partial diffs aren't worth the complexity here since cycle KPI lists
 * are short. On save success we patch the react-query cache directly via
 * setQueryData instead of invalidating cycleDetail; that avoids the
 * mid-edit refetch flicker that used to wipe focus and remount the
 * trend selector portal.
 *
 * When this cycle is empty and a prior cycle has KPIs, a "Continue from
 * {prior label}" CTA pre-populates the rows with the prior labels (values
 * blank). Each row also shows a "↳ was X last month" hint when its label
 * matches a prior KPI. Trend is auto-derived from the numeric delta when
 * both current and prior values parse as numbers; the manual buttons
 * below still let the coach override for non-numeric metrics.
 */
export function CycleKpiEditor({
  cycleId,
  initialKpis,
  priorKpis = [],
  priorCycleLabel = null,
}: {
  cycleId: string;
  initialKpis: KpiRow[];
  priorKpis?: KpiRow[];
  priorCycleLabel?: string | null;
}) {
  const utils = trpc.useUtils();
  const [rows, setRows] = useState<KpiRowWithId[]>(() =>
    initialKpis.map((k) => ({ ...k, _id: nextId() })),
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Persist the last-saved JSON so we can ignore upstream re-renders
  // that re-emit the same array reference.
  const lastSavedRef = useRef<string>(JSON.stringify(cleanRows(initialKpis)));

  // Re-seed only when the upstream value structurally differs from what
  // we just saved (e.g. cycle switch, server returns new data after a
  // sibling page mutated). Reference-only change is ignored.
  useEffect(() => {
    const upstream = JSON.stringify(cleanRows(initialKpis));
    if (upstream !== lastSavedRef.current) {
      setRows(initialKpis.map((k) => ({ ...k, _id: nextId() })));
      lastSavedRef.current = upstream;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKpis]);

  // Lookup map for prior KPIs by lowercased label, used for the "↳ was
  // X last month" hint and for auto-trend derivation.
  const priorByLabel = useMemo(() => {
    const m = new Map<string, KpiRow>();
    for (const k of priorKpis) m.set(k.label.trim().toLowerCase(), k);
    return m;
  }, [priorKpis]);

  const update = trpc.roster.updateCycle.useMutation({
    onSuccess: (updated) => {
      lastSavedRef.current = JSON.stringify(cleanRows(rows));
      setSavedAt(Date.now());
      setError(null);
      // Patch the cycleDetail cache in place instead of invalidating —
      // that's what eliminates the mid-edit refetch flicker. The
      // workspace's other reads (e.g. the InputSlot summary count) read
      // off cycleSummary, which we DO invalidate so the headline stats
      // stay fresh.
      utils.roster.cycleDetail.setData({ cycleId }, (prev) => {
        if (!prev) return prev;
        return { ...prev, cycle: { ...prev.cycle, kpis: updated.kpis ?? [] } };
      });
      utils.roster.cycleSummary.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  // Debounced save on any structural change. We strip the _id field
  // and drop blank rows before sending so a half-typed Add KPI doesn't
  // fail the zod min(1) on label/value.
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

  function patchRow(id: string, patch: Partial<KpiRow>) {
    setRows((prev) => prev.map((r) => (r._id === id ? { ...r, ...patch } : r)));
  }
  function addRow(seed?: Partial<KpiRow>) {
    setRows((prev) => [
      ...prev,
      { _id: nextId(), label: '', value: '', ...seed },
    ]);
  }
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r._id !== id));
  }
  function copyFromPrior() {
    setRows(
      priorKpis.map((k) => ({
        _id: nextId(),
        label: k.label,
        value: '',
        // Trend is derived per-row at render — we don't carry the prior
        // trend forward as the new cycle's trend, since that would lie.
      })),
    );
  }

  const showCopyCta = rows.length === 0 && priorKpis.length > 0;

  return (
    <div className="grid gap-2">
      {showCopyCta ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-2.5 py-2">
          <span className="text-[11px] italic text-muted-foreground">
            No KPIs logged yet.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={copyFromPrior}
          >
            <CornerDownRight className="mr-1 h-3 w-3" /> Continue from{' '}
            {priorCycleLabel ?? 'last cycle'} ({priorKpis.length})
          </Button>
          <span className="text-[11px] text-muted-foreground/70">or</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => addRow()}
          >
            <Plus className="mr-1 h-3 w-3" /> Add new KPI
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="px-1 text-[11px] italic text-muted-foreground">
          No KPIs logged for this cycle yet — add a metric to start tracking.
        </p>
      ) : (
        <div className="grid gap-1.5">
          {rows.map((row) => {
            const prior =
              row.label.trim().length > 0
                ? priorByLabel.get(row.label.trim().toLowerCase()) ?? null
                : null;
            return (
              <KpiRowEditor
                key={row._id}
                row={row}
                prior={prior}
                onPatch={(patch) => patchRow(row._id, patch)}
                onRemove={() => removeRow(row._id)}
              />
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex items-center gap-3 px-1 text-[10px] text-muted-foreground">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 border-dashed px-2 text-[11px] text-muted-foreground"
            onClick={() => addRow()}
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
      )}
    </div>
  );
}

/* ─────────────────────── Row primitive ─────────────────────── */

const KpiRowEditor = memo(function KpiRowEditor({
  row,
  prior,
  onPatch,
  onRemove,
}: {
  row: KpiRowWithId;
  prior: KpiRow | null;
  onPatch: (patch: Partial<KpiRow>) => void;
  onRemove: () => void;
}) {
  // Auto-derive trend whenever the value or prior changes IF both parse
  // as numbers. Manual override (clicking a trend button) sets a "sticky"
  // trend that the auto-derivation respects — coaches need to be able to
  // mark "down" on a metric where the comparison-derived direction would
  // be wrong (e.g. inverted KPIs like "Days to close").
  const autoTrend = useMemo(() => deriveTrend(prior?.value, row.value), [prior, row.value]);
  const stickyTrendRef = useRef<boolean>(!!row.trend);
  useEffect(() => {
    // If we have an autoTrend and the user hasn't explicitly clicked a
    // trend in this session, mirror it onto the row. Doesn't fight a
    // manual override since stickyTrendRef stays true after a click.
    if (!stickyTrendRef.current && autoTrend && autoTrend !== row.trend) {
      onPatch({ trend: autoTrend });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTrend]);

  function setTrend(t: 'up' | 'down' | 'flat' | undefined) {
    stickyTrendRef.current = t !== undefined;
    onPatch({ trend: t });
  }

  return (
    <div
      className="grid items-start gap-2 rounded-md border border-border bg-muted/10 px-2 py-1.5"
      style={{ gridTemplateColumns: '180px 1fr 110px 1fr 28px' }}
    >
      <Input
        value={row.label}
        onChange={(e) => onPatch({ label: e.target.value })}
        placeholder="Label (e.g. Revenue)"
        className="h-7 text-xs"
      />
      <div className="grid gap-1">
        <Input
          value={row.value}
          onChange={(e) => onPatch({ value: e.target.value })}
          placeholder="Value (e.g. $5.2M)"
          className="h-7 text-xs"
        />
        {prior && (
          <span className="px-1 text-[10px] text-muted-foreground">
            ↳ was <span className="font-mono">{prior.value}</span> last cycle
          </span>
        )}
      </div>
      <TrendButtons
        value={row.trend}
        derived={autoTrend}
        onChange={setTrend}
      />
      <Input
        value={row.note ?? ''}
        onChange={(e) => onPatch({ note: e.target.value })}
        placeholder="Note (optional)"
        className="h-7 text-xs"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label="Remove KPI"
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
});

function TrendButtons({
  value,
  derived,
  onChange,
}: {
  value: KpiRow['trend'];
  derived: KpiRow['trend'];
  onChange: (t: 'up' | 'down' | 'flat' | undefined) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded border border-border bg-background p-0.5">
      {TREND_OPTIONS.map(({ id, Icon, tone }) => {
        const active = value === id;
        const isDerived = !value && derived === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(active ? undefined : id)}
            className={cn(
              'inline-flex h-5 w-7 items-center justify-center rounded-sm transition-colors',
              active
                ? 'bg-foreground text-background'
                : isDerived
                  ? 'bg-muted/60 ' + tone
                  : 'text-muted-foreground hover:bg-muted',
            )}
            aria-label={`Trend ${id}${isDerived ? ' (auto)' : ''}`}
            aria-pressed={active}
          >
            <Icon className="h-3 w-3" />
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────── Helpers ─────────────────────── */

function cleanRows(rows: Array<KpiRow | KpiRowWithId>): KpiRow[] {
  return rows
    .map((r) => ({
      label: r.label.trim(),
      value: r.value.trim(),
      trend: r.trend,
      note: r.note?.trim() || undefined,
    }))
    .filter((r) => r.label && r.value);
}

/**
 * Pull a numeric value out of a KPI cell. Strips currency symbols,
 * commas, and a trailing M/MM/B/K multiplier. Returns null if there's
 * no recognisable number.
 *
 *  "$5.2M"   →  5_200_000
 *  "1.2 mm"  →  1_200_000
 *  "12%"     →  12
 *  "two"     →  null
 */
function parseNumeric(input: string | undefined | null): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/[$£€,]/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(k|m|mm|bn|b)?\s*%?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2];
  if (!mult) return n;
  if (mult === 'k') return n * 1_000;
  if (mult === 'm' || mult === 'mm') return n * 1_000_000;
  if (mult === 'b' || mult === 'bn') return n * 1_000_000_000;
  return n;
}

function deriveTrend(
  prior: string | undefined | null,
  current: string | undefined | null,
): 'up' | 'down' | 'flat' | undefined {
  const a = parseNumeric(prior);
  const b = parseNumeric(current);
  if (a === null || b === null) return undefined;
  if (a === 0) {
    if (b === 0) return 'flat';
    return b > 0 ? 'up' : 'down';
  }
  const pct = (b - a) / Math.abs(a);
  if (pct > 0.01) return 'up';
  if (pct < -0.01) return 'down';
  return 'flat';
}
