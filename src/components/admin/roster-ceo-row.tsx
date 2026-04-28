'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Pencil, ArrowRightLeft, ExternalLink, Trash2, Inbox } from 'lucide-react';
import { RosterEditCeoDialog } from './roster-edit-ceo-dialog';
import { RosterReassignCeoDialog } from './roster-reassign-ceo-dialog';
import { RosterDeleteCeoDialog } from './roster-delete-ceo-dialog';
import { CeoDataDrawer } from './ceo-data-drawer';

export interface RosterCeoRowData {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  tenXGoal: string | null;
  coachId: string;
  cycleCount: number;
  hasReport: boolean;
  latestCycleLabel: string | null;
  aliasEmails: string[];
}

interface CoachOption {
  id: string;
  name: string;
  email: string;
}

export function RosterCeoRow({
  ceo,
  coaches,
  highlight,
}: {
  ceo: RosterCeoRowData;
  coaches: CoachOption[];
  highlight?: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);

  const coachName =
    coaches.find((c) => c.id === ceo.coachId)?.name ?? 'Unknown coach';

  return (
    <div className="group flex items-center gap-3 px-6 py-2.5 transition-colors hover:bg-muted/30">
      <CeoAvatar name={ceo.name} avatarUrl={ceo.avatarUrl} size="sm" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            href={`/ceos/${ceo.id}`}
            className="truncate text-sm font-medium hover:underline"
          >
            <Highlight text={ceo.name} match={highlight} />
          </Link>
          {ceo.tenXGoal && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              10x set
            </Badge>
          )}
          {ceo.hasReport && (
            <Badge
              variant="outline"
              className="shrink-0 border-emerald-500/30 text-[10px] text-emerald-700 dark:text-emerald-400"
            >
              report
            </Badge>
          )}
          {ceo.aliasEmails.length > 1 && (
            <span className="shrink-0 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              +{ceo.aliasEmails.length - 1} alias{ceo.aliasEmails.length - 1 === 1 ? '' : 'es'}
            </span>
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          <Highlight text={ceo.email ?? '(no primary email)'} match={highlight} />
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setDataOpen(true)}
          aria-label={`Inspect data for ${ceo.name}`}
          className="rounded-md px-2 py-1 text-right transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <p className="tabular-nums">{ceo.cycleCount}</p>
          <p className="text-[10px] uppercase tracking-wider">cycles</p>
        </button>
        {ceo.latestCycleLabel && (
          <div className="px-1 text-right">
            <p className="font-mono">{ceo.latestCycleLabel}</p>
            <p className="text-[10px] text-muted-foreground/70">latest</p>
          </div>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 opacity-60 group-hover:opacity-100"
              aria-label="Actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => setDataOpen(true)}>
              <Inbox className="mr-2 h-3.5 w-3.5" /> Inspect data
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/ceos/${ceo.id}`}>
                <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setEditOpen(true)}>
              <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setReassignOpen(true)}>
              <ArrowRightLeft className="mr-2 h-3.5 w-3.5" /> Reassign coach
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setDeleteOpen(true)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <RosterEditCeoDialog
        ceo={{
          id: ceo.id,
          name: ceo.name,
          email: ceo.email,
          tenXGoal: ceo.tenXGoal,
        }}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <RosterReassignCeoDialog
        ceo={{ id: ceo.id, name: ceo.name, coachId: ceo.coachId }}
        coaches={coaches}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
      />
      <RosterDeleteCeoDialog
        ceo={{ id: ceo.id, name: ceo.name, cycleCount: ceo.cycleCount }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
      <CeoDataDrawer
        ceoId={ceo.id}
        ceoName={ceo.name}
        coachName={coachName}
        open={dataOpen}
        onOpenChange={setDataOpen}
      />
    </div>
  );
}

function Highlight({ text, match }: { text: string; match?: string }) {
  if (!match || !match.trim()) return <>{text}</>;
  const q = match.trim().toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return <>{text}</>;
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
