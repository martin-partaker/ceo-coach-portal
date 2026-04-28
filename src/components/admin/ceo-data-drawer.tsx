'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  Search,
  Video,
} from 'lucide-react';

type FilterTab = 'all' | 'submissions' | 'transcripts';

interface Props {
  ceoId: string;
  ceoName: string;
  coachName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CeoDataDrawer({
  ceoId,
  ceoName,
  coachName,
  open,
  onOpenChange,
}: Props) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading } = trpc.inbox.listForCeo.useQuery(
    { ceoId, search: search.trim() || undefined },
    { enabled: open }
  );

  const items = data?.items ?? [];
  const totalCycles = data?.totalCycles ?? 0;

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'transcripts') {
      return items.filter((r) => r.rawInput.contentType === 'transcript');
    }
    return items.filter((r) => r.rawInput.contentType !== 'transcript');
  }, [items, filter]);

  // Hide the filter strip until the list is dense enough to justify it.
  const showFilters = items.length >= 10;

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle>{ceoName}</SheetTitle>
          <SheetDescription>
            Coach: {coachName} ·{' '}
            <span className="tabular-nums">{items.length}</span>{' '}
            submission{items.length === 1 ? '' : 's'} ·{' '}
            <span className="tabular-nums">{totalCycles}</span>{' '}
            cycle{totalCycles === 1 ? '' : 's'}
          </SheetDescription>
        </SheetHeader>

        {showFilters && (
          <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
            <FilterPill
              active={filter === 'all'}
              onClick={() => setFilter('all')}
              count={items.length}
            >
              All
            </FilterPill>
            <FilterPill
              active={filter === 'submissions'}
              onClick={() => setFilter('submissions')}
              count={
                items.filter((r) => r.rawInput.contentType !== 'transcript')
                  .length
              }
            >
              Submissions
            </FilterPill>
            <FilterPill
              active={filter === 'transcripts'}
              onClick={() => setFilter('transcripts')}
              count={
                items.filter((r) => r.rawInput.contentType === 'transcript')
                  .length
              }
            >
              Transcripts
            </FilterPill>
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search text…"
                className="h-7 w-44 pl-7 text-xs"
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState hasItems={items.length > 0} />
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((row) => (
                <DataRow
                  key={row.rawInput.id}
                  ceoId={ceoId}
                  row={row}
                  expanded={expanded.has(row.rawInput.id)}
                  onToggle={() => toggle(row.rawInput.id)}
                />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FilterPill({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
        active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {children}
      <span
        className={cn(
          'tabular-nums text-[10px]',
          active ? 'text-background/70' : 'text-muted-foreground/70'
        )}
      >
        {count}
      </span>
    </button>
  );
}

function EmptyState({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center">
      <Inbox className="h-6 w-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">
        {hasItems ? 'No matches' : 'No data yet'}
      </p>
      <p className="text-xs text-muted-foreground">
        {hasItems
          ? 'Try a different filter or clear the search.'
          : 'Nothing has been assigned to this CEO yet.'}
      </p>
    </div>
  );
}

interface DataRowProps {
  ceoId: string;
  row: {
    rawInput: {
      id: string;
      source: string;
      contentType: string;
      occurredAt: Date | string;
      textContent: string | null;
      matchStatus: string;
    };
    cycle: { id: string; label: string } | null;
    projected: boolean;
  };
  expanded: boolean;
  onToggle: () => void;
}

function DataRow({ ceoId, row, expanded, onToggle }: DataRowProps) {
  const occurred = new Date(row.rawInput.occurredAt);
  const dateStr = occurred.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      occurred.getFullYear() === new Date().getFullYear() ? undefined : '2-digit',
  });
  const Icon = row.rawInput.contentType === 'transcript' ? Video : FileText;
  const isArchived = row.rawInput.matchStatus === 'archived';
  const text = row.rawInput.textContent ?? '';
  const oneLine = text.replace(/\s+/g, ' ').trim().slice(0, 140);

  return (
    <div
      className={cn(
        'group transition-colors',
        expanded ? 'bg-muted/30' : 'hover:bg-muted/20'
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-5 py-2.5 text-left"
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono">{dateStr}</span>
            <span>·</span>
            <span>{row.rawInput.source}</span>
            <span>·</span>
            <span className="text-foreground/70">{row.rawInput.contentType}</span>
            {isArchived && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] uppercase tracking-wider text-muted-foreground"
              >
                archived
              </Badge>
            )}
          </div>
          <p
            className={cn(
              'mt-1 text-xs',
              expanded ? 'text-foreground/80' : 'truncate text-muted-foreground'
            )}
          >
            {oneLine || (
              <span className="italic text-muted-foreground/60">
                (no extracted text)
              </span>
            )}
          </p>
        </div>
        <ChevronRight
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-3 px-5 pb-4">
          {text && (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-sans text-xs leading-relaxed text-foreground/90">
              {text}
            </pre>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {row.cycle ? (
              <Link
                href={`/ceos/${ceoId}/cycles/${row.cycle.id}`}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Cycle {row.cycle.label}
                <ExternalLink className="h-3 w-3" />
              </Link>
            ) : (
              <span className="text-muted-foreground">No cycle</span>
            )}
            {row.projected ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CircleCheck className="h-3 w-3" /> projected
              </span>
            ) : (
              <span className="text-muted-foreground/70">not projected</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
