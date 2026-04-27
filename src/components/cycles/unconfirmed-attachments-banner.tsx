'use client';

import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Check, Users, X } from 'lucide-react';

interface ClassificationLite {
  meetingType?: string;
  participantsSummary?: string;
}

export function UnconfirmedAttachmentsBanner({ cycleId }: { cycleId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.cycles.unconfirmedAttachments.useQuery({ cycleId });

  const confirm = trpc.cycles.confirmAttachment.useMutation({
    onSuccess: () => utils.cycles.unconfirmedAttachments.invalidate({ cycleId }),
  });
  const detach = trpc.cycles.detachAttachment.useMutation({
    onSuccess: () => utils.cycles.unconfirmedAttachments.invalidate({ cycleId }),
  });

  if (isLoading || !data || data.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 space-y-3">
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {data.length} attached item{data.length === 1 ? '' : 's'} need
              {data.length === 1 ? 's' : ''} confirmation
            </p>
            <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">
              Auto-attached based on a fuzzy match or a group session. Confirm or detach.
            </p>
          </div>

          <div className="space-y-1.5">
            {data.map((row) => {
              const classification = (row.classification ?? {}) as ClassificationLite;
              const isGroup = classification.meetingType === 'coaching_group';
              const occurred = new Date(row.occurredAt).toISOString().slice(0, 10);
              return (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {row.source}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {row.contentType}
                      </Badge>
                      {row.matchConfidence != null && row.matchConfidence < 100 && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {row.matchConfidence}% match
                        </span>
                      )}
                      {isGroup && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] text-purple-700 dark:text-purple-300">
                          <Users className="h-3 w-3" /> group session
                        </span>
                      )}
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {occurred}
                      </span>
                    </div>
                    {classification.participantsSummary && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {classification.participantsSummary}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => confirm.mutate({ rawInputId: row.id })}
                      disabled={confirm.isPending}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" /> Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => detach.mutate({ rawInputId: row.id })}
                      disabled={detach.isPending}
                    >
                      <X className="mr-1 h-3.5 w-3.5" /> Detach
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
