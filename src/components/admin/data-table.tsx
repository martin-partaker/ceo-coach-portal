'use client';

import { useState, useEffect } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { MatchToExistingButton } from './match-to-existing-button';
import {
  Mail,
  FileText,
  Video,
  Search,
  Loader2,
  Eye,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_VALUES = [
  'matched',
  'pending_ceo',
  'pending_cycle',
  'pending_classification',
  'discarded',
  'archived',
  'internal',
] as const;
type Status = (typeof STATUS_VALUES)[number];

const SOURCE_VALUES = ['zoom', 'tally'] as const;
type Source = (typeof SOURCE_VALUES)[number];

const CONTENT_TYPES = [
  'intake',
  'goal_worksheet',
  'monthly_journal',
  'weekly_journal',
  'self_assessment',
  'support_feedback',
  'transcript',
  'coach_note',
  'fallback_doc',
  'unknown',
] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

const STATUS_LABEL: Record<Status, string> = {
  matched: 'Matched',
  pending_ceo: 'Pending CEO',
  pending_cycle: 'Pending cycle',
  pending_classification: 'Pending class.',
  discarded: 'Discarded',
  archived: 'Archived',
  internal: 'Internal',
};

const STATUS_TONE: Record<Status, string> = {
  matched: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  pending_ceo: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  pending_cycle: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  pending_classification: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  discarded: 'bg-destructive/15 text-destructive',
  archived: 'bg-muted text-muted-foreground',
  internal: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
};

const CONTENT_TYPE_LABEL: Record<string, string> = {
  weekly_journal: 'Weekly journal',
  monthly_journal: 'Monthly journal',
  goal_worksheet: '10x worksheet',
  intake: 'Intake',
  self_assessment: 'Self-assessment',
  support_feedback: 'Support',
  transcript: 'Transcript',
  coach_note: 'Coach note',
  fallback_doc: 'Doc',
  unknown: '—',
};

const PAGE_SIZE = 50;

function sourceIcon(source: string) {
  if (source === 'zoom') return Video;
  if (source === 'tally') return FileText;
  return Mail;
}

interface RowDetail {
  id: string;
  ceoId: string | null;
  source: string;
  contentType: string;
  matchStatus: string;
  occurredAt: Date;
  payloadJson: unknown;
  textContent: string | null;
  classification: unknown;
  matchCandidates: unknown;
  externalId: string;
}

export function DataTable() {
  const utils = trpc.useUtils();
  // Filter state
  const [statuses, setStatuses] = useState<Set<Status>>(
    new Set(['matched', 'pending_ceo', 'pending_cycle']),
  );
  const [source, setSource] = useState<Source | ''>('');
  const [contentType, setContentType] = useState<ContentType | ''>('');
  const [ceoId, setCeoId] = useState<string | 'unassigned' | ''>('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [offset, setOffset] = useState(0);

  // Debounce search input so we don't fire a query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const ceosQuery = trpc.admin.listAllCeos.useQuery();

  const dataQuery = trpc.inbox.dataView.useQuery(
    {
      statuses: statuses.size > 0 ? Array.from(statuses) : undefined,
      source: source || undefined,
      contentType: contentType || undefined,
      ceoId: ceoId || undefined,
      search: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset,
    },
    { placeholderData: keepPreviousData },
  );

  const setStatusMutation = trpc.inbox.setStatus.useMutation({
    onSuccess: () => {
      utils.inbox.dataView.invalidate();
      utils.inbox.pendingCounts.invalidate();
    },
  });

  const reprojectMutation = trpc.inbox.reproject.useMutation({
    onSuccess: () => utils.inbox.dataView.invalidate(),
  });

  const [detailRow, setDetailRow] = useState<RowDetail | null>(null);
  const [matchOpen, setMatchOpen] = useState<string | null>(null);

  function toggleStatus(s: Status) {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
    setOffset(0);
  }

  function clearFilters() {
    setStatuses(new Set(['matched', 'pending_ceo', 'pending_cycle']));
    setSource('');
    setContentType('');
    setCeoId('');
    setSearch('');
    setOffset(0);
  }

  const total = dataQuery.data?.total ?? 0;
  const items = dataQuery.data?.items ?? [];
  const hasNext = offset + PAGE_SIZE < total;
  const hasPrev = offset > 0;

  const ceoOptions = ceosQuery.data ?? [];

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Status pills */}
          <div className="flex flex-wrap gap-1">
            {STATUS_VALUES.map((s) => {
              const active = statuses.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    active
                      ? STATUS_TONE[s] + ' border-transparent'
                      : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                  )}
                >
                  {STATUS_LABEL[s]}
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Source */}
            <Select value={source || 'any'} onValueChange={(v) => { setSource(v === 'any' ? '' : (v as Source)); setOffset(0); }}>
              <SelectTrigger className="h-8 w-[110px] text-xs">
                <SelectValue placeholder="Any source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any source</SelectItem>
                <SelectItem value="zoom">Zoom</SelectItem>
                <SelectItem value="tally">Tally</SelectItem>
              </SelectContent>
            </Select>
            {/* Content type */}
            <Select value={contentType || 'any'} onValueChange={(v) => { setContentType(v === 'any' ? '' : (v as ContentType)); setOffset(0); }}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue placeholder="Any type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any type</SelectItem>
                {CONTENT_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CONTENT_TYPE_LABEL[c] ?? c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* CEO */}
            <Select value={ceoId || 'any'} onValueChange={(v) => { setCeoId(v === 'any' ? '' : (v as string)); setOffset(0); }}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue placeholder="Any CEO" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any CEO</SelectItem>
                <SelectItem value="unassigned">— Unassigned</SelectItem>
                {ceoOptions.map((row) => (
                  <SelectItem key={row.ceo.id} value={row.ceo.id}>
                    {row.ceo.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search transcript / submission text…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={clearFilters} className="h-8 text-xs">
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
        </div>
      </div>

      {/* Result summary */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {dataQuery.isFetching ? 'Loading…' : `${total.toLocaleString()} row${total === 1 ? '' : 's'}`}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!hasPrev} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="h-7 text-xs">
            ← Prev
          </Button>
          <span className="px-2 tabular-nums">
            {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)}
          </span>
          <Button size="sm" variant="ghost" disabled={!hasNext} onClick={() => setOffset(offset + PAGE_SIZE)} className="h-7 text-xs">
            Next →
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {dataQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
            <p className="text-sm font-medium">No rows match these filters.</p>
            <p className="text-xs text-muted-foreground">
              Try widening the status set or clearing search.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">CEO</th>
                <th className="px-3 py-2">Coach</th>
                <th className="px-3 py-2">Topic / Content</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map(({ rawInput, ceo, coach }) => {
                const SourceIcon = sourceIcon(rawInput.source);
                const status = rawInput.matchStatus as Status;
                const occurred = new Date(rawInput.occurredAt);
                const payload = (rawInput.payloadJson ?? {}) as {
                  meeting?: { topic?: string };
                  formName?: string;
                };
                const topic =
                  payload.meeting?.topic ??
                  payload.formName ??
                  (rawInput.textContent
                    ? rawInput.textContent.slice(0, 80).replace(/\s+/g, ' ').trim()
                    : '—');
                return (
                  <tr key={rawInput.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {occurred.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: '2-digit',
                      })}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-[11px]">
                          {CONTENT_TYPE_LABEL[rawInput.contentType] ?? rawInput.contentType}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={status}
                        onValueChange={(v) =>
                          setStatusMutation.mutate({
                            rawInputId: rawInput.id,
                            status: v as Status,
                          })
                        }
                        disabled={setStatusMutation.isPending}
                      >
                        <SelectTrigger
                          className={cn(
                            'h-7 w-[130px] border-0 px-2 text-[11px]',
                            STATUS_TONE[status],
                          )}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_VALUES.map((s) => (
                            <SelectItem key={s} value={s} className="text-xs">
                              {STATUS_LABEL[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-3 py-2">
                      {ceo?.id ? (
                        <div className="flex items-center gap-1.5">
                          <CeoAvatar name={ceo.name ?? '?'} avatarUrl={null} size="sm" />
                          <span className="text-[12px]">{ceo.name}</span>
                        </div>
                      ) : (
                        <span className="text-[11px] italic text-muted-foreground">unassigned</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground">
                      {coach?.name ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <p className="line-clamp-1 max-w-[320px] text-[12px] text-foreground/90">
                        {topic}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setMatchOpen(rawInput.id)}
                          className="h-6 px-2 text-[11px]"
                          aria-label="Change CEO"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setDetailRow({
                              id: rawInput.id,
                              ceoId: rawInput.ceoId,
                              source: rawInput.source,
                              contentType: rawInput.contentType,
                              matchStatus: rawInput.matchStatus,
                              occurredAt: rawInput.occurredAt,
                              payloadJson: rawInput.payloadJson,
                              textContent: rawInput.textContent,
                              classification: rawInput.classification,
                              matchCandidates: rawInput.matchCandidates,
                              externalId: rawInput.externalId,
                            })
                          }
                          className="h-6 px-2 text-[11px]"
                          aria-label="View payload"
                        >
                          <Eye className="h-3 w-3" />
                        </Button>
                        {rawInput.matchStatus === 'matched' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              reprojectMutation.mutate({ rawInputId: rawInput.id })
                            }
                            className="h-6 px-2 text-[11px]"
                            disabled={reprojectMutation.isPending}
                            title="Re-run projector"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                      {matchOpen === rawInput.id && (
                        <MatchToExistingButton
                          rawInputId={rawInput.id}
                          submissionEmail={null}
                          open={matchOpen === rawInput.id}
                          onOpenChange={(v) => !v && setMatchOpen(null)}
                          hideTrigger
                          onMatched={() => setMatchOpen(null)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <RowDetailDrawer row={detailRow} onClose={() => setDetailRow(null)} />
    </div>
  );
}

function RowDetailDrawer({
  row,
  onClose,
}: {
  row: RowDetail | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!row} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between gap-2">
            Row detail
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </SheetTitle>
          <SheetDescription>
            Full payload + extracted fields for this raw_input.
          </SheetDescription>
        </SheetHeader>
        {row && (
          <div className="mt-4 space-y-4 px-4 pb-6 text-sm">
            <Block label="ID" value={row.id} mono />
            <Block label="External ID" value={row.externalId} mono />
            <Block label="Source" value={row.source} />
            <Block label="Content type" value={row.contentType} />
            <Block label="Status" value={row.matchStatus} />
            <Block label="Occurred at" value={new Date(row.occurredAt).toISOString()} mono />

            {row.classification != null && (
              <details className="rounded-lg border border-border" open>
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Classification
                </summary>
                <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11px] text-foreground/90">
                  {JSON.stringify(row.classification, null, 2)}
                </pre>
              </details>
            )}

            {row.matchCandidates != null && (
              <details className="rounded-lg border border-border">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Match candidates
                </summary>
                <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11px] text-foreground/90">
                  {JSON.stringify(row.matchCandidates, null, 2)}
                </pre>
              </details>
            )}

            {row.textContent && (
              <details className="rounded-lg border border-border">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Text content ({row.textContent.length.toLocaleString()} chars)
                </summary>
                <pre className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words px-3 pb-3 text-[12px] text-foreground/90">
                  {row.textContent}
                </pre>
              </details>
            )}

            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                payload_json
              </summary>
              <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11px] text-foreground/90">
                {JSON.stringify(row.payloadJson, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Block({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-32 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={cn('break-all', mono && 'font-mono text-[11px]')}>{value}</span>
    </div>
  );
}
