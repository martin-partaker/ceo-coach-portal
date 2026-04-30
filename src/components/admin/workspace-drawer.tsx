'use client';

import { CeoAvatar } from '@/components/ui/ceo-avatar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { RosterCeoSummary, RosterCycle } from '@/server/api/routers/roster';
import { CycleWorkspace } from './roster-v2-workspace';

interface Props {
  summary: RosterCeoSummary;
  cycles: RosterCycle[];
  activeCycleId: string;
  onActiveCycleIdChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Wraps CycleWorkspace in a wide right-side Sheet so the same expanded
 * workspace UI can be opened from the Manager Gantt without navigating
 * away. The workspace already provides its own tab strip and "Open full
 * page" link.
 */
export function WorkspaceDrawer({
  summary,
  cycles,
  activeCycleId,
  onActiveCycleIdChange,
  open,
  onOpenChange,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-screen p-0 sm:max-w-[min(1200px,calc(100vw-3rem))]"
      >
        <SheetHeader className="flex-row items-center gap-3">
          <CeoAvatar
            name={summary.ceo.name}
            avatarUrl={summary.ceo.avatarUrl}
            size="sm"
          />
          <div className="min-w-0">
            <SheetTitle className="truncate">{summary.ceo.name}</SheetTitle>
            <SheetDescription className="truncate">
              {summary.coach ? `Coach ${summary.coach.name}` : 'Unassigned'}
              {summary.ceo.email ? ` · ${summary.ceo.email}` : ''}
            </SheetDescription>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          <CycleWorkspace
            summary={summary}
            cycles={cycles}
            activeCycleId={activeCycleId}
            onActiveCycleIdChange={onActiveCycleIdChange}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
