'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Loader2, Search, Link2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  rawInputId: string;
  /** Email present in the submission; offered as an alias to add. */
  submissionEmail?: string | null;
  /** Called after a successful match — useful for parent state updates. */
  onMatched?: () => void;
}

interface CeoRow {
  ceo: { id: string; name: string; email: string | null };
  coach: { id: string; name: string };
  aliasEmails: string[];
  cycleCount: number;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-amber-300/40 text-foreground dark:bg-amber-500/30">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * Compute a quick relevance score for ranking — used only when the operator
 * has typed something or when we want to surface "Suggested for this submission".
 */
function relevanceScore(row: CeoRow, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const fields = [row.ceo.name, row.ceo.email ?? '', ...row.aliasEmails, row.coach.name];
  let best = 0;
  for (const f of fields) {
    const lower = f.toLowerCase();
    if (lower.includes(q)) {
      best = Math.max(best, 1 + (lower.startsWith(q) ? 0.5 : 0));
    } else {
      best = Math.max(best, levenshteinRatio(lower, q));
    }
  }
  return best;
}

function suggestedFor(row: CeoRow, submissionEmail: string | null | undefined): number {
  if (!submissionEmail) return 0;
  const candidates = [row.ceo.email ?? '', ...row.aliasEmails].filter(Boolean);
  let best = 0;
  for (const c of candidates) {
    const r = levenshteinRatio(submissionEmail.toLowerCase(), c.toLowerCase());
    if (r > best) best = r;
  }
  return best;
}

export function MatchToExistingButton({ rawInputId, submissionEmail, onMatched }: Props) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [addAlias, setAddAlias] = useState(true);

  const { data: rows, isLoading } = trpc.admin.listAllCeos.useQuery(undefined, {
    enabled: open,
  });

  const { suggested, filtered } = useMemo(() => {
    if (!rows) return { suggested: [] as CeoRow[], filtered: [] as CeoRow[] };

    // Suggested matches based on the submission email — only when no search query
    let suggested: CeoRow[] = [];
    if (!query.trim() && submissionEmail) {
      suggested = [...rows]
        .map((r) => ({ ...r, _score: suggestedFor(r, submissionEmail) }))
        .filter((r) => r._score >= 0.6)
        .sort((a, b) => b._score - a._score)
        .slice(0, 3);
    }

    // Filtered list: when query present, use relevance score; else show all sorted by name
    let filtered: CeoRow[] = rows;
    if (query.trim()) {
      filtered = [...rows]
        .map((r) => ({ ...r, _score: relevanceScore(r, query.trim()) }))
        .filter((r) => r._score > 0.4)
        .sort((a, b) => b._score - a._score);
    }

    return { suggested, filtered };
  }, [rows, query, submissionEmail]);

  const assign = trpc.inbox.assignToCeo.useMutation({
    onSuccess: (data) => {
      utils.inbox.listPending.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
      if (data?.autoResolved && data.autoResolved > 0) {
        console.info(`Assigned; auto-resolved ${data.autoResolved} more pending row(s).`);
      }
      onMatched?.();
      setOpen(false);
    },
  });

  const renderRow = (row: CeoRow, isSuggested = false) => (
    <button
      key={`${isSuggested ? 'sug' : 'all'}-${row.ceo.id}`}
      className={cn(
        'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors',
        'hover:bg-muted/60 disabled:opacity-50',
        isSuggested && 'bg-amber-500/[0.04]'
      )}
      onClick={() =>
        assign.mutate({
          rawInputId,
          ceoId: row.ceo.id,
          addAliasFromSubmission: !!submissionEmail && addAlias,
        })
      }
      disabled={assign.isPending}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">
            {highlightMatch(row.ceo.name, query)}
          </p>
          {row.aliasEmails.length > 1 && (
            <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              +{row.aliasEmails.length - 1} alias{row.aliasEmails.length - 1 === 1 ? '' : 'es'}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {highlightMatch(row.ceo.email ?? '(no primary email)', query)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {row.cycleCount} cycle{row.cycleCount === 1 ? '' : 's'}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">
          {highlightMatch(row.coach.name, query)}
        </span>
      </div>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Link2 className="mr-1.5 h-3.5 w-3.5" />
          Match
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Match to an existing CEO</DialogTitle>
          <DialogDescription>
            Pick the CEO this submission belongs to. Searches across all coaches.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, alias, or coach…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
              autoFocus
            />
          </div>

          {submissionEmail && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <Checkbox
                id="add-alias"
                checked={addAlias}
                onCheckedChange={(c) => setAddAlias(c === true)}
              />
              <Label htmlFor="add-alias" className="cursor-pointer text-xs font-normal">
                Add{' '}
                <span className="font-mono text-foreground">{submissionEmail}</span> as an
                alias on the chosen CEO (so future submissions match automatically)
              </Label>
            </div>
          )}

          <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border">
            {isLoading && (
              <div className="flex items-center justify-center p-6">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!isLoading && filtered.length === 0 && suggested.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {query ? 'No matches.' : 'No CEOs in the system yet.'}
              </p>
            )}

            {/* Suggested matches based on submission email */}
            {!query && suggested.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 border-b border-border bg-amber-500/[0.06] px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  <Sparkles className="h-3 w-3" />
                  Suggested for this submission
                </div>
                <div className="divide-y divide-border">
                  {suggested.map((row) => renderRow(row, true))}
                </div>
                {filtered.length > 0 && (
                  <div className="border-y border-border bg-muted/30 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    All CEOs
                  </div>
                )}
              </>
            )}

            <div className="divide-y divide-border">
              {filtered.map((row) => renderRow(row, false))}
            </div>
          </div>

          {assign.error && (
            <p className="text-sm text-destructive">{assign.error.message}</p>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
