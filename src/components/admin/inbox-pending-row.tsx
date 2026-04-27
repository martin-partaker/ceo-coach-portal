'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Plus } from 'lucide-react';

interface PendingCandidate {
  ceoId: string;
  ceoName: string;
  score: number;
}

interface FuzzyCandidatesEntry {
  candidateName: string;
  candidateEmail: string | null;
  topMatches: PendingCandidate[];
}

interface MatchCandidates {
  reason?: string;
  email?: string;
  name?: string;
  // Zoom fuzzy structure (array)
  [key: number]: FuzzyCandidatesEntry;
}

interface InboxRow {
  rawInput: {
    id: string;
    source: string;
    contentType: string;
    occurredAt: Date | string;
    textContent: string | null;
    matchCandidates: unknown;
    matchStatus: string;
  };
  ceo: { id: string; name: string } | null;
  coach: { id: string; name: string } | null;
}

export function InboxPendingRow({ row }: { row: InboxRow }) {
  const utils = trpc.useUtils();
  const candidates = row.rawInput.matchCandidates as MatchCandidates | null;

  const fuzzyEntries: FuzzyCandidatesEntry[] = Array.isArray(candidates)
    ? (candidates as unknown as FuzzyCandidatesEntry[])
    : [];

  const reason =
    candidates && !Array.isArray(candidates)
      ? (candidates as { reason?: string }).reason ?? null
      : null;
  const submissionEmail =
    candidates && !Array.isArray(candidates)
      ? (candidates as { email?: string }).email ?? null
      : null;
  const submissionName =
    candidates && !Array.isArray(candidates)
      ? (candidates as { name?: string }).name ?? null
      : null;

  const assignToCeo = trpc.inbox.assignToCeo.useMutation({
    onSuccess: () => {
      utils.inbox.listPending.invalidate();
      utils.inbox.pendingCounts.invalidate();
    },
  });
  const discard = trpc.inbox.discard.useMutation({
    onSuccess: () => {
      utils.inbox.listPending.invalidate();
      utils.inbox.pendingCounts.invalidate();
    },
  });

  const occurred = new Date(row.rawInput.occurredAt);
  const snippet = (row.rawInput.textContent ?? '').slice(0, 220);

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">
              {row.rawInput.source}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {row.rawInput.contentType}
            </Badge>
            <span className="font-mono">
              {occurred.toISOString().slice(0, 10)}
            </span>
            {reason && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                {reason}
              </span>
            )}
          </div>

          {(submissionName || submissionEmail) && (
            <p className="mt-2 text-sm">
              {submissionName && <span className="font-medium">{submissionName}</span>}
              {submissionEmail && (
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {submissionEmail}
                </span>
              )}
            </p>
          )}

          {fuzzyEntries.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {fuzzyEntries.map((e, i) => (
                <div key={i} className="text-xs">
                  <span className="font-medium">{e.candidateName}</span>
                  {e.candidateEmail && (
                    <span className="ml-2 font-mono text-muted-foreground">
                      {e.candidateEmail}
                    </span>
                  )}
                  {e.topMatches.length > 0 && (
                    <span className="ml-2 text-muted-foreground">
                      → top:{' '}
                      {e.topMatches.slice(0, 3).map((m, j) => (
                        <button
                          key={j}
                          className="ml-1 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 hover:bg-muted/70 disabled:opacity-50"
                          onClick={() =>
                            assignToCeo.mutate({
                              rawInputId: row.rawInput.id,
                              ceoId: m.ceoId,
                            })
                          }
                          disabled={assignToCeo.isPending}
                        >
                          {m.ceoName}
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {Math.round(m.score * 100)}%
                          </span>
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {snippet && (
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{snippet}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {submissionEmail && submissionName && row.coach && (
            <CreateCeoButton
              rawInputId={row.rawInput.id}
              defaultName={submissionName}
              defaultEmail={submissionEmail}
              defaultCoachId={row.coach.id}
            />
          )}
          {!row.coach && submissionEmail && submissionName && (
            <CreateCeoButton
              rawInputId={row.rawInput.id}
              defaultName={submissionName}
              defaultEmail={submissionEmail}
              defaultCoachId={null}
            />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              discard.mutate({
                rawInputId: row.rawInput.id,
                reason: 'admin_discarded',
              })
            }
            disabled={discard.isPending}
          >
            Discard
          </Button>
        </div>
      </div>
    </div>
  );
}

function CreateCeoButton({
  rawInputId,
  defaultName,
  defaultEmail,
  defaultCoachId,
}: {
  rawInputId: string;
  defaultName: string;
  defaultEmail: string;
  defaultCoachId: string | null;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [coachId, setCoachId] = useState<string | null>(defaultCoachId);

  const { data: coachesList } = trpc.admin.listCoaches.useQuery();
  const create = trpc.inbox.createCeoFromInput.useMutation({
    onSuccess: () => {
      utils.inbox.listPending.invalidate();
      utils.inbox.pendingCounts.invalidate();
      setOpen(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New CEO
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create CEO from submission</DialogTitle>
          <DialogDescription>
            This creates a new CEO record and attaches this submission.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-ceo-name">Name</Label>
            <Input
              id="new-ceo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-ceo-email">Email</Label>
            <Input
              id="new-ceo-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Coach</Label>
            <Select value={coachId ?? ''} onValueChange={(v) => setCoachId(v || null)}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a coach" />
              </SelectTrigger>
              <SelectContent>
                {(coachesList ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {create.error && (
          <p className="mt-2 text-sm text-destructive">{create.error.message}</p>
        )}
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              coachId &&
              create.mutate({
                rawInputId,
                name: name.trim(),
                email: email.trim(),
                coachId,
              })
            }
            disabled={create.isPending || !coachId || !name.trim() || !email.trim()}
          >
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create + assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
