'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { Download, Loader2, Video, AlertCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ZoomImportDialogProps {
  cycleId: string;
  ceoId: string;
  hasZoomEmail: boolean;
}

export function ZoomImportDialog({ cycleId, ceoId, hasZoomEmail }: ZoomImportDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const recordings = trpc.zoom.listRecordings.useQuery(
    { ceoId },
    { enabled: open && hasZoomEmail }
  );

  const importTranscript = trpc.zoom.importTranscript.useMutation({
    onSuccess: () => {
      setImportSuccess(true);
      setTimeout(() => {
        setOpen(false);
        setImportSuccess(false);
        setSelectedMeetingId(null);
        router.refresh();
      }, 1500);
    },
  });

  function handleImport(meetingId: number) {
    setSelectedMeetingId(meetingId);
    importTranscript.mutate({ cycleId, meetingId });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setImportSuccess(false); setSelectedMeetingId(null); } }}>
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
            Select a recent meeting to import its transcript.
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
              <p className="mt-3 text-sm font-medium">Transcript imported</p>
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
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {recordings.data.map((meeting) => (
                <button
                  key={meeting.id}
                  type="button"
                  disabled={importTranscript.isPending}
                  onClick={() => handleImport(meeting.id)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors',
                    selectedMeetingId === meeting.id && importTranscript.isPending
                      ? 'border-primary/50 bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{meeting.topic}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground font-mono">
                      {new Date(meeting.startTime).toLocaleDateString()} &middot;{' '}
                      {meeting.duration} min
                    </p>
                  </div>
                  <div className="ml-3 shrink-0">
                    {selectedMeetingId === meeting.id && importTranscript.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : meeting.hasTranscript ? (
                      <Badge variant="secondary" className="text-[10px]">Has transcript</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">No transcript</Badge>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {importTranscript.error && (
            <p className="mt-3 text-sm text-destructive">{importTranscript.error.message}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
