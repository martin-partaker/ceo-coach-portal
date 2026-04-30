'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, FilePlus } from 'lucide-react';

interface Props {
  cycleId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManualTranscriptDialog({ cycleId, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const today = new Date().toISOString().slice(0, 10);

  const [title, setTitle] = useState('');
  const [recordedAt, setRecordedAt] = useState(today);
  const [duration, setDuration] = useState('');
  const [content, setContent] = useState('');

  function reset() {
    setTitle('');
    setRecordedAt(today);
    setDuration('');
    setContent('');
  }

  const add = trpc.cycles.addTranscript.useMutation({
    onSuccess: () => {
      utils.roster.cycleDetail.invalidate({ cycleId });
      utils.roster.cycleSummary.invalidate();
      reset();
      onOpenChange(false);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    add.mutate({
      cycleId,
      title: title.trim(),
      content: content.trim(),
      recordedAt: recordedAt || null,
      duration: duration ? Number(duration) : null,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Paste a meeting transcript</DialogTitle>
            <DialogDescription>
              For meetings that didn&apos;t come from Zoom, or when you only have
              the raw text. Stored exactly as you paste it.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mt-title">Title *</Label>
              <Input
                id="mt-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Strategy review – May 15"
                required
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mt-date">Recorded on</Label>
                <Input
                  id="mt-date"
                  type="date"
                  value={recordedAt}
                  onChange={(e) => setRecordedAt(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mt-duration">Duration (min)</Label>
                <Input
                  id="mt-duration"
                  type="number"
                  min={0}
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  placeholder="60"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mt-content">Transcript *</Label>
              <Textarea
                id="mt-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Paste the full transcript here…"
                required
                rows={14}
                className="font-mono text-xs leading-relaxed"
              />
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {content.length.toLocaleString()} chars
              </p>
            </div>
          </div>

          {add.error && (
            <p className="mt-3 text-sm text-destructive">{add.error.message}</p>
          )}

          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={add.isPending || !title.trim() || !content.trim()}
            >
              {add.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FilePlus className="mr-2 h-4 w-4" />
              )}
              Add transcript
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
