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
import type { KpiKind } from '@/db/schema';

/* ─────────────────── Types from cycleDetail ─────────────────── */

export interface KpiCellData {
  /** When non-null we're talking to an existing definition; the editor
   *  passes the id back so the server doesn't need to label-match. */
  definition: {
    id: string;
    label: string;
    unit: string | null;
    target: string | null;
    kind: KpiKind;
    sortOrder: number;
  };
  current: { value: string; trend: string | null; note: string | null } | null;
  prior: { value: string; trend: string | null; note: string | null } | null;
  /** Oldest → newest. Includes current cycle's value when present.
   *  Step C consumes this for the inline sparkline. */
  series: Array<{
    cycleId: string;
    cycleLabel: string;
    value: string;
    trend: 'up' | 'down' | 'flat' | null;
    note: string | null;
  }>;
}

interface EditorRow {
  /** Stable client-side id. Persisted definitions use their real id;
   *  freshly typed rows use a synthetic prefix that the upsert ignores. */
  _id: string;
  /** When set, the server treats this row as an existing definition. */
  definitionId?: string;
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
  note?: string;
  unit?: string;
  target?: string;
  kind?: KpiKind;
}

const SAVE_DEBOUNCE_MS = 600;
const TREND_OPTIONS: Array<{ id: 'up' | 'down' | 'flat'; Icon: typeof ArrowUp; tone: string }> = [
  { id: 'up', Icon: ArrowUp, tone: 'text-emerald-600 dark:text-emerald-400' },
  { id: 'flat', Icon: ArrowRight, tone: 'text-muted-foreground' },
  { id: 'down', Icon: ArrowDown, tone: 'text-destructive' },
];

let _idCounter = 0;
const synthId = () => `new-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;

function rowsFromKpis(kpis: KpiCellData[]): EditorRow[] {
  return kpis.map((k) => ({
    _id: k.definition.id,
    definitionId: k.definition.id,
    label: k.definition.label,
    value: k.current?.value ?? '',
    trend: (k.current?.trend ?? undefined) as EditorRow['trend'],
    note: k.current?.note ?? undefined,
    unit: k.definition.unit ?? undefined,
    target: k.definition.target ?? undefined,
    kind: k.definition.kind,
  }));
}

/**
 * Inline KPI editor for the cycle workspace.
 *
 * Step B switched the schema from cycles.kpis JSONB to normalized
 * ceo_kpi_definitions + cycle_kpi_values, and this editor talks to the
 * new roster.upsertKpis mutation. Each row is a label / value / trend
 * triple plus optional note + unit + target. Definitions persist across
 * cycles, so adding a row in cycle N also makes it appear (empty) on
 * cycle N+1's editor via the prior-cycle rows passed in props.
 *
 * UX behaviours kept from step A:
 *   - "Continue from {prior cycle label}" CTA when the cycle has no
 *     definitions yet but a prior cycle had some.
 *   - "↳ was X last cycle" hint inline under the value input.
 *   - Auto-derived trend when both current + prior values parse as
 *     numbers, with a manual override that "sticks".
 *   - Stable React keys + memo'd rows + setQueryData on save (no
 *     mid-edit refetch flicker).
 */
export function CycleKpiEditor({
  cycleId,
  kpis,
  priorCycleLabel = null,
}: {
  cycleId: string;
  kpis: KpiCellData[];
  priorCycleLabel?: string | null;
}) {
  const utils = trpc.useUtils();
  const [rows, setRows] = useState<EditorRow[]>(() => rowsFromKpis(kpis));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSavedRef = useRef<string>(JSON.stringify(serializeForSave(rowsFromKpis(kpis))));

  // Re-seed only when the upstream value structurally differs from what
  // we just saved (cycle switch, server-side change). Reference-only
  // re-renders are ignored.
  useEffect(() => {
    const upstream = rowsFromKpis(kpis);
    const upstreamKey = JSON.stringify(serializeForSave(upstream));
    if (upstreamKey !== lastSavedRef.current) {
      setRows(upstream);
      lastSavedRef.current = upstreamKey;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpis]);

  // Hint lookup: prior values keyed by definition id (preferred) and
  // by lowercased label (fallback for freshly-typed rows that don't
  // have a definitionId yet but happen to use a known label).
  const priorByDef = useMemo(() => {
    const m = new Map<string, KpiCellData['prior']>();
    for (const k of kpis) if (k.prior) m.set(k.definition.id, k.prior);
    return m;
  }, [kpis]);
  const priorByLabel = useMemo(() => {
    const m = new Map<string, KpiCellData['prior']>();
    for (const k of kpis) if (k.prior) m.set(k.definition.label.trim().toLowerCase(), k.prior);
    return m;
  }, [kpis]);
  const priorKpis = useMemo(() => kpis.filter((k) => k.prior !== null), [kpis]);

  const upsert = trpc.roster.upsertKpis.useMutation({
    onSuccess: () => {
      lastSavedRef.current = JSON.stringify(serializeForSave(rows));
      setSavedAt(Date.now());
      setError(null);
      // Invalidate cycleDetail (we *want* the server-merged definitions
      // back so freshly-created rows pick up their persisted ids), but
      // skip cycleSummary since KPIs aren't in that shape.
      utils.roster.cycleDetail.invalidate({ cycleId });
    },
    onError: (e) => setError(e.message),
  });

  // Debounced save on any structural change.
  useEffect(() => {
    const cleaned = serializeForSave(rows);
    const next = JSON.stringify(cleaned);
    if (next === lastSavedRef.current) return;
    const t = setTimeout(() => {
      upsert.mutate({ cycleId, rows: cleaned });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cycleId]);

  const dirty = JSON.stringify(serializeForSave(rows)) !== lastSavedRef.current;
  const showSaved = savedAt && Date.now() - savedAt < 4000 && !dirty;

  function patchRow(id: string, patch: Partial<EditorRow>) {
    setRows((prev) => prev.map((r) => (r._id === id ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [
      ...prev,
      { _id: synthId(), label: '', value: '', kind: 'text' },
    ]);
  }
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r._id !== id));
  }
  function copyFromPrior() {
    setRows(
      priorKpis.map((k) => ({
        _id: k.definition.id,
        definitionId: k.definition.id,
        label: k.definition.label,
        value: '',
        unit: k.definition.unit ?? undefined,
        target: k.definition.target ?? undefined,
        kind: k.definition.kind,
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
            onClick={addRow}
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
              (row.definitionId && priorByDef.get(row.definitionId)) ||
              (row.label.trim() &&
                priorByLabel.get(row.label.trim().toLowerCase())) ||
              null;
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
            {upsert.isPending ? (
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
  row: EditorRow;
  prior: { value: string; trend: string | null; note: string | null } | null;
  onPatch: (patch: Partial<EditorRow>) => void;
  onRemove: () => void;
}) {
  const autoTrend = useMemo(() => deriveTrend(prior?.value, row.value), [prior, row.value]);
  const stickyTrendRef = useRef<boolean>(!!row.trend);
  useEffect(() => {
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
  value: EditorRow['trend'];
  derived: EditorRow['trend'];
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

function serializeForSave(rows: EditorRow[]) {
  return rows
    .map((r, i) => ({
      definitionId: r.definitionId,
      label: r.label.trim(),
      value: r.value.trim(),
      trend: r.trend,
      note: r.note?.trim() || undefined,
      unit: r.unit?.trim() || undefined,
      target: r.target?.trim() || undefined,
      kind: r.kind,
      sortOrder: i * 10,
    }))
    .filter((r) => r.label && r.value);
}

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
