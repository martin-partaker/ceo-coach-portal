'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  cycleId: string;
  cycleLabel: string;
  ceoName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PromptInspector({
  cycleId,
  cycleLabel,
  ceoName,
  open,
  onOpenChange,
}: Props) {
  const { data, isLoading, error } = trpc.reports.previewPrompt.useQuery(
    { cycleId },
    { enabled: open, staleTime: 30_000 }
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Inspect prompt — {cycleLabel}</SheetTitle>
          <SheetDescription>
            Exact prompt the AI will see when generating {ceoName}&apos;s email.
            Read-only.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error.message}
            </div>
          )}

          {data && (
            <div className="space-y-5">
              {data.missing.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <p className="font-medium">Missing inputs</p>
                    <p className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">
                      {data.missing.join(', ')}. The AI will be told to work
                      with what exists and flag the gaps.
                    </p>
                  </div>
                </div>
              )}

              <PromptSection
                title="System prompt"
                subtitle="Sets the AI's role, voice, and output format"
                content={data.systemPrompt}
              />

              <PromptSection
                title="User prompt"
                subtitle="Cycle-specific context: 10x goal, journals, transcript, action items, previous reports"
                content={data.userPrompt}
              />

              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Total length:{' '}
                <span className="font-mono tabular-nums text-foreground">
                  {(data.systemPrompt.length + data.userPrompt.length).toLocaleString()}
                </span>{' '}
                chars (~
                {Math.round((data.systemPrompt.length + data.userPrompt.length) / 4).toLocaleString()}{' '}
                tokens)
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PromptSection({
  title,
  subtitle,
  content,
}: {
  title: string;
  subtitle: string;
  content: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section>
      <div className="mb-1.5 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="text-xs text-muted-foreground/80">{subtitle}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={copy}
        >
          {copied ? (
            <>
              <Check className="mr-1 h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3 w-3" /> Copy
            </>
          )}
        </Button>
      </div>
      <pre
        className={cn(
          'max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 font-mono text-[11px] leading-relaxed text-foreground/90'
        )}
      >
        {content}
      </pre>
      <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/70">
        {content.length.toLocaleString()} chars
      </p>
    </section>
  );
}
