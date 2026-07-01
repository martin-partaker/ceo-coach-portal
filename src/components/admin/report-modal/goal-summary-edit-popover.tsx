'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Check, Loader2, Pencil } from 'lucide-react';

/**
 * Inline editor for the Goal Summary section.
 *
 * Goal Summary is a structured sub-object (10x / 90-day / 30-day) derived
 * from the model's goal cascade, so it doesn't fit the generic per-section
 * refine popover (which edits a single string/list). This popover edits
 * the three goal lines directly and saves via `reports.update`, which
 * merges the sub-fields so the coach-only `flag` is preserved.
 *
 * Raw edit only (no AI refine) — the goals are short, factual lines the
 * coach usually just corrects by hand.
 */
type GoalSummaryValue = {
  tenX?: string;
  ninetyDay?: string | null;
  thirtyDay?: string | null;
  flag?: string | null;
} | null;

export function GoalSummaryEditPopover({
  reportId,
  value,
}: {
  reportId: string;
  value: GoalSummaryValue;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          aria-label="Edit Goal Summary"
          title="Edit the 10x / 90-day / 30-day goals"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[420px] p-0">
        {open && (
          <GoalSummaryEditBody
            reportId={reportId}
            value={value}
            onSaved={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function GoalSummaryEditBody({
  reportId,
  value,
  onSaved,
}: {
  reportId: string;
  value: GoalSummaryValue;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const [tenX, setTenX] = useState(value?.tenX ?? '');
  const [ninetyDay, setNinetyDay] = useState(value?.ninetyDay ?? '');
  const [thirtyDay, setThirtyDay] = useState(value?.thirtyDay ?? '');

  const update = trpc.reports.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.reports.getForCycle.invalidate(),
        utils.reports.getForReportId.invalidate({ reportId }),
        utils.reports.getReportVersions.invalidate(),
      ]);
      onSaved();
    },
  });

  function save() {
    if (update.isPending) return;
    update.mutate({
      reportId,
      goalSummary: {
        tenX: tenX.trim(),
        // Empty 90/30-day lines persist as null so the renderer hides the
        // row instead of showing an empty bullet.
        ninetyDay: ninetyDay.trim() || null,
        thirtyDay: thirtyDay.trim() || null,
      },
    });
  }

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-3 py-2">
        <p className="text-[12px] font-semibold">Edit — Goal Summary</p>
        <p className="text-[10.5px] text-muted-foreground">
          Edit the goal lines directly. Leave 90/30-day blank to hide them.
        </p>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="space-y-1">
          <Label className="text-[11px]">10x Goal</Label>
          <Textarea
            value={tenX}
            onChange={(e) => setTenX(e.target.value)}
            rows={2}
            className="text-[12px]"
            disabled={update.isPending}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">90-Day Goal</Label>
          <Textarea
            value={ninetyDay}
            onChange={(e) => setNinetyDay(e.target.value)}
            rows={2}
            className="text-[12px]"
            disabled={update.isPending}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">30-Day Goal</Label>
          <Textarea
            value={thirtyDay}
            onChange={(e) => setThirtyDay(e.target.value)}
            rows={2}
            className="text-[12px]"
            disabled={update.isPending}
          />
        </div>

        {update.error && (
          <p className="text-[11px] text-destructive">{update.error.message}</p>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={save}
            disabled={update.isPending}
            className="h-7 text-[11px]"
          >
            {update.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Check className="mr-1 h-3 w-3" />
            )}
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
