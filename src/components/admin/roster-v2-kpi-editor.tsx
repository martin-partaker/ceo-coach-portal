'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  Loader2,
  Plus,
  Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { KpiKind } from '@/db/schema';
import { KpiSparkline } from './roster-v2-kpi-sparkline';

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

const KIND_OPTIONS: Array<{ id: KpiKind; label: string }> = [
  { id: 'number', label: 'Number' },
  { id: 'currency', label: 'Currency ($)' },
  { id: 'percent', label: 'Percent (%)' },
  { id: 'count', label: 'Count' },
  { id: 'text', label: 'Text' },
];

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
  ceoId,
  kpis,
  priorCycleLabel = null,
}: {
  cycleId: string;
  ceoId: string;
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
  function moveRow(id: string, delta: 1 | -1) {
    setRows((prev) => {
      const i = prev.findIndex((r) => r._id === id);
      if (i < 0) return prev;
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // Archive instead of hard-delete: the definition keeps its history
  // for old reports, just disappears from the editor + new prompts.
  // Falls back to client-only removal if the row was never persisted.
  const archive = trpc.roster.archiveKpiDefinition.useMutation({
    onSuccess: () => {
      utils.roster.cycleDetail.invalidate({ cycleId });
    },
  });
  function removeRow(id: string) {
    const row = rows.find((r) => r._id === id);
    setRows((prev) => prev.filter((r) => r._id !== id));
    if (row?.definitionId) {
      archive.mutate({ definitionId: row.definitionId });
    }
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
        // Dead-end empty state fix: when there are no rows AND no prior
        // cycles to copy from, we still need an obvious way to add the
        // first KPI. The pure-text variant was unreachable — the only
        // other "Add KPI" button lives below the row list, which renders
        // only when rows.length > 0.
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-2.5 py-2">
          <span className="flex-1 text-[11px] italic text-muted-foreground">
            No KPIs logged for this cycle yet.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={addRow}
          >
            <Plus className="mr-1 h-3 w-3" /> Add KPI
          </Button>
        </div>
      ) : (
        <div className="grid gap-1.5">
          {rows.map((row, idx) => {
            const prior =
              (row.definitionId && priorByDef.get(row.definitionId)) ||
              (row.label.trim() &&
                priorByLabel.get(row.label.trim().toLowerCase())) ||
              null;
            const series =
              (row.definitionId &&
                kpis.find((k) => k.definition.id === row.definitionId)?.series) ||
              [];
            return (
              <KpiRowEditor
                key={row._id}
                row={row}
                prior={prior}
                series={series}
                isFirst={idx === 0}
                isLast={idx === rows.length - 1}
                onPatch={(patch) => patchRow(row._id, patch)}
                onRemove={() => removeRow(row._id)}
                onMoveUp={() => moveRow(row._id, -1)}
                onMoveDown={() => moveRow(row._id, 1)}
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

      <ArchivedDisclosure cycleId={cycleId} ceoId={ceoId} />
    </div>
  );
}

function ArchivedDisclosure({ cycleId, ceoId }: { cycleId: string; ceoId: string }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const archived = trpc.roster.listArchivedKpiDefinitions.useQuery(
    { ceoId },
    { enabled: open, staleTime: 30_000 },
  );
  const unarchive = trpc.roster.unarchiveKpiDefinition.useMutation({
    onSuccess: () => {
      utils.roster.listArchivedKpiDefinitions.invalidate({ ceoId });
      utils.roster.cycleDetail.invalidate({ cycleId });
    },
  });

  const count = archived.data?.length ?? 0;
  // Hide the disclosure entirely when there's nothing to restore — no
  // need to advertise an empty section.
  if (open === false && count === 0 && !archived.isLoading) {
    // Probe once to know whether to show the toggle at all.
  }

  return (
    <div className="px-1 pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/80 hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-2.5 w-2.5" />
        ) : (
          <ChevronUp className="h-2.5 w-2.5 rotate-90" />
        )}
        Archived KPIs{count > 0 ? ` (${count})` : ''}
      </button>
      {open && (
        <div className="mt-2 grid gap-1.5 rounded-md border border-dashed border-border bg-muted/10 p-2">
          {archived.isLoading && (
            <span className="text-[10px] text-muted-foreground">Loading…</span>
          )}
          {!archived.isLoading && count === 0 && (
            <span className="text-[10px] italic text-muted-foreground">
              No archived KPIs.
            </span>
          )}
          {(archived.data ?? []).map((def) => (
            <div
              key={def.id}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{def.label}</div>
                {def.archivedAt && (
                  <div className="text-[10px] text-muted-foreground">
                    archived{' '}
                    {new Date(def.archivedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </div>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() =>
                  unarchive.mutate({ definitionId: def.id })
                }
                disabled={unarchive.isPending}
              >
                <ArchiveRestore className="mr-1 h-3 w-3" /> Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Row primitive ─────────────────────── */

const KpiRowEditor = memo(function KpiRowEditor({
  row,
  prior,
  series,
  isFirst,
  isLast,
  onPatch,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  row: EditorRow;
  prior: { value: string; trend: string | null; note: string | null } | null;
  series: Array<{ value: string }>;
  isFirst: boolean;
  isLast: boolean;
  onPatch: (patch: Partial<EditorRow>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const autoTrend = useMemo(() => deriveTrend(prior?.value, row.value), [prior, row.value]);

  // Auto-derive trend silently. We removed the user-facing trend
  // selector — it was visually competing with the reorder chevrons and
  // people kept misreading it as another reorder control. Trend is now
  // an output of the value/prior comparison, not an input. For
  // non-numeric KPIs where the math doesn't apply, trend stays
  // undefined; the prompt still gets the value, just without a
  // direction signal.
  useEffect(() => {
    if (autoTrend !== row.trend) {
      onPatch({ trend: autoTrend });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTrend]);

  // Δ% between prior and current — surfaced in the hint line so the
  // coach can read trajectory at a glance without a separate widget.
  const deltaPct = useMemo(() => {
    const a = parseNumeric(prior?.value);
    const b = parseNumeric(row.value);
    if (a === null || b === null || a === 0) return null;
    return ((b - a) / Math.abs(a)) * 100;
  }, [prior, row.value]);

  // Progress against target — only meaningful when both current value
  // and target parse as numbers. Capped at [0, 100].
  const progress = useMemo(() => {
    const cur = parseNumeric(row.value);
    const tgt = parseNumeric(row.target);
    if (cur === null || tgt === null || tgt === 0) return null;
    const pct = Math.max(0, Math.min(100, (cur / tgt) * 100));
    return { pct, cur, tgt };
  }, [row.value, row.target]);

  // Build the value-input placeholder: when no current value AND we
  // have a prior, surface "Last: $4.2M" right inside the field so the
  // coach can see the anchor without looking elsewhere.
  const valuePlaceholder = prior?.value
    ? `Last: ${prior.value}`
    : 'Value (e.g. $5.2M)';

  return (
    <div className="grid gap-1.5 rounded-md border border-border bg-muted/10 px-2 py-1.5">
      <div
        className="grid items-start gap-2"
        style={{
          // No trend column — trend is auto-derived below the value.
          // Value gets 2fr, label gets 1fr, sparkline shrinks a bit so
          // the value input is always the dominant cell.
          gridTemplateColumns:
            '20px minmax(0, 1fr) minmax(0, 2fr) 84px 28px 28px',
        }}
      >
        {/* Reorder column — up/down stacked vertically. */}
        <div className="flex flex-col">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label="Move up"
            className={cn(
              'h-3 text-muted-foreground transition-colors',
              isFirst ? 'opacity-30' : 'hover:text-foreground',
            )}
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            aria-label="Move down"
            className={cn(
              'h-3 text-muted-foreground transition-colors',
              isLast ? 'opacity-30' : 'hover:text-foreground',
            )}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>

        <Input
          value={row.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="Label (e.g. Revenue)"
          className="h-7 text-xs"
        />
        <div className="grid min-w-0 gap-1">
          <div className="relative">
            <Input
              value={row.value}
              onChange={(e) => onPatch({ value: e.target.value })}
              placeholder={valuePlaceholder}
              className="h-7 pr-9 text-xs"
            />
            {/* Auto-derived trend indicator — passive. Keeps the
                direction signal visible without competing with the
                reorder chevrons. Hidden when there's no derivation
                possible (non-numeric or first cycle). */}
            {autoTrend && row.value.trim() && (
              <span
                className={cn(
                  'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs',
                  autoTrend === 'up' &&
                    'text-emerald-600 dark:text-emerald-400',
                  autoTrend === 'down' &&
                    'text-destructive',
                  autoTrend === 'flat' && 'text-muted-foreground',
                )}
                aria-label={`Trend ${autoTrend}`}
              >
                {autoTrend === 'up' ? '▲' : autoTrend === 'down' ? '▼' : '–'}
              </span>
            )}
          </div>
          {prior && (
            <span className="px-1 text-[10px] text-muted-foreground">
              ↳ was <span className="font-mono">{prior.value}</span> last cycle
              {deltaPct !== null && row.value.trim() && (
                <>
                  {' '}
                  <span
                    className={cn(
                      'font-mono tabular-nums',
                      deltaPct > 0.5 && 'text-emerald-600 dark:text-emerald-400',
                      deltaPct < -0.5 && 'text-destructive',
                    )}
                  >
                    ({deltaPct >= 0 ? '+' : ''}
                    {deltaPct.toFixed(deltaPct > 100 ? 0 : 1)}%)
                  </span>
                </>
              )}
            </span>
          )}
          {progress && (
            <ProgressBar pct={progress.pct} target={row.target ?? ''} />
          )}
        </div>
        <div className="flex items-center justify-center pt-0.5">
          <KpiSparkline series={series} width={72} height={20} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="KPI settings"
          aria-expanded={settingsOpen}
        >
          <Settings2 className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label="Archive KPI"
        >
          <Archive className="h-3 w-3" />
        </Button>
      </div>

      {settingsOpen && (
        <div className="grid gap-2 rounded border border-border bg-background px-2.5 py-2 text-xs">
          <div className="grid gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Note
            </span>
            <Input
              value={row.note ?? ''}
              onChange={(e) => onPatch({ note: e.target.value })}
              placeholder="Optional context for this measurement"
              className="h-7 text-xs"
            />
          </div>
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: '1fr 1fr 1fr' }}
          >
            <div className="grid gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Kind
              </span>
              <select
                value={row.kind ?? 'text'}
                onChange={(e) =>
                  onPatch({ kind: e.target.value as KpiKind })
                }
                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Unit
              </span>
              <Input
                value={row.unit ?? ''}
                onChange={(e) => onPatch({ unit: e.target.value })}
                placeholder="e.g. $, %, customers"
                className="h-7 text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Target
              </span>
              <Input
                value={row.target ?? ''}
                onChange={(e) => onPatch({ target: e.target.value })}
                placeholder="e.g. $10M"
                className="h-7 text-xs"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function ProgressBar({ pct, target }: { pct: number; target: string }) {
  return (
    <div className="grid gap-0.5 px-1">
      <div className="relative h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 transition-[width] dark:bg-emerald-400"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {pct.toFixed(0)}% of <span className="font-mono">{target}</span> target
      </span>
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
