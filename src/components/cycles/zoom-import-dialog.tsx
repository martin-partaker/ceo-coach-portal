'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
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
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { Download, Loader2, Video, AlertCircle, CheckCircle2 } from 'lucide-react';

interface ZoomImportDialogProps {
  cycleId: string;
  ceoId: string;
  hasZoomEmail: boolean;
  existingTranscript?: string;
  onTranscriptImported?: (transcript: string) => void;
}

export function ZoomImportDialog({ cycleId, ceoId, hasZoomEmail, existingTranscript, onTranscriptImported }: ZoomImportDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState(false);

  const recordings = trpc.zoom.listRecordings.useQuery(
    { ceoId },
    { enabled: open && hasZoomEmail }
  );

  const importTranscript = trpc.zoom.importTranscript.useMutation();

  function toggleSelection(meetingId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(meetingId)) next.delete(meetingId);
      else next.add(meetingId);
      return next;
    });
  }

  async function handleImport() {
    if (selected.size === 0) return;
    setImporting(true);

    const transcripts: string[] = [];

    for (const meetingId of selected) {
      const meeting = recordings.data?.find((m) => m.id === meetingId);
      try {
        const result = await importTranscript.mutateAsync({ cycleId, meetingId });
        const header = `=== ${meeting?.topic ?? 'Meeting'} (${meeting ? new Date(meeting.startTime).toLocaleDateString() : ''}, ${meeting?.duration ?? 0} min) ===`;
        transcripts.push(`${header}\n\n${result.cycle.zoomTranscript ?? ''}`);
      } catch {
        // Skip failed transcripts, continue with others
      }
    }

    if (transcripts.length > 0) {
      const newContent = transcripts.join('\n\n\n');
      const combined = existingTranscript
        ? `${existingTranscript.trimEnd()}\n\n\n${newContent}`
        : newContent;
      onTranscriptImported?.(combined);
    }

    setImporting(false);
    setImportSuccess(true);
    setTimeout(() => {
      setOpen(false);
      setImportSuccess(false);
      setSelected(new Set());
      router.refresh();
    }, 1200);
  }

  function handleOpenChange(v: boolean) {
    setOpen(v);
    if (!v) {
      setImportSuccess(false);
      setSelected(new Set());
    }
  }

  // Check which meeting topics are already imported
  function isAlreadyImported(topic: string): boolean {
    if (!existingTranscript) return false;
    return existingTranscript.includes(`=== ${topic} (`);
  }

  const meetingsWithTranscript = recordings.data?.filter((m) => m.hasTranscript) ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Import from Zoom
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Zoom Transcript</DialogTitle>
          <DialogDescription>
            Select one or more meetings to import transcripts from.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          {!hasZoomEmail ? (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-300">Zoom email not set</p>
                <p className="mt-1 text-amber-700 dark:text-amber-400/80">
                  <Link href="/settings" className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-300">Go to Settings</Link> and enter your Zoom email address first.
                </p>
              </div>
            </div>
          ) : importSuccess ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
              <p className="mt-3 text-sm font-medium">
                {selected.size > 1 ? `${selected.size} transcripts imported` : 'Transcript imported'}
              </p>
            </div>
          ) : recordings.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading recordings...</span>
            </div>
          ) : recordings.error ? (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Failed to load recordings</p>
                <p className="mt-1 text-muted-foreground">{recordings.error.message}</p>
              </div>
            </div>
          ) : !recordings.data?.length ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Video className="h-8 w-8 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium">No recordings found</p>
              <p className="mt-1 text-xs text-muted-foreground">
                No cloud-recorded meetings found in the last 30 days.
              </p>
            </div>
          ) : (
            <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {recordings.data.map((meeting) => {
                const isSelected = selected.has(meeting.id);
                const alreadyImported = isAlreadyImported(meeting.topic);
                const canSelect = meeting.hasTranscript && !alreadyImported;
                return (
                  <div
                    key={meeting.id}
                    onClick={() => canSelect && toggleSelection(meeting.id)}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                      isSelected ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/50'
                    } ${!canSelect ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => canSelect && toggleSelection(meeting.id)}
                      disabled={!canSelect}
                      className="mt-0.5"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">{meeting.topic}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground font-mono">
                        {new Date(meeting.startTime).toLocaleDateString()} &middot; {meeting.duration} min
                      </p>
                    </div>
                    <div className="shrink-0 pt-0.5">
                      {alreadyImported ? (
                        <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[10px] whitespace-nowrap">Imported</Badge>
                      ) : meeting.hasTranscript ? (
                        <Badge variant="secondary" className="text-[10px] whitespace-nowrap">Transcript</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground whitespace-nowrap">No transcript</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {hasZoomEmail && !importSuccess && meetingsWithTranscript.length > 0 && (
          <DialogFooter>
            <Button
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
              size="sm"
            >
              {importing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-4 w-4" />
              )}
              {importing
                ? 'Importing...'
                : selected.size === 0
                  ? 'Select meetings'
                  : `Import ${selected.size} transcript${selected.size > 1 ? 's' : ''}`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
