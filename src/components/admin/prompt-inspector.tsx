'use client';

import { useState } from 'react';
import JSZip from 'jszip';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { AlertTriangle, Check, Copy, Download, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const PROMPT_SEPARATOR = '\n\n========== USER MESSAGE ==========\n\n';

function buildMainPrompt(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt}${PROMPT_SEPARATOR}${userPrompt}`;
}

function slugifyForFile(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'item';
}

function buildReadme({
  ceoName,
  cycleLabel,
}: {
  ceoName: string;
  cycleLabel: string;
}): string {
  return `# Coaching email generation bundle

CEO: **${ceoName}**
Cycle: **${cycleLabel}**
Exported: ${new Date().toISOString()}

This zip contains everything the platform feeds into the model when it
generates the monthly coaching email. Use it to reproduce the
generation in any off-platform LLM (ChatGPT, Claude.ai, Gemini, etc.).

## How to use

### Option A — single paste (simplest)
1. Open ChatGPT / Claude.ai / your LLM of choice.
2. Open \`main-prompt.md\` and copy the entire contents.
3. Paste into a new chat and send. The prompt is fully self-contained.

### Option B — file uploads + paste
1. Upload every file under \`context/\` to the chat as attachments.
2. Paste \`main-prompt.md\` as the message.
3. The prompt references the same content that's in the attachments,
   so either approach works — pick whichever the LLM you're using
   handles best.

## What's inside

- \`main-prompt.md\` — the system prompt + user prompt concatenated,
  separated by \`${PROMPT_SEPARATOR.trim()}\`. Paste this whole thing.
- \`system-prompt.md\` — system prompt only (role, voice, output format,
  curriculum framework, resource catalog).
- \`user-prompt.md\` — user prompt only (CEO inputs for this cycle).
- \`context/\` — every raw input broken into its own file, in the order
  the prompt references them:
  - \`00-ceo-profile.md\` — name, 10x goal, cycle metadata
  - \`01-monthly-goals.md\`
  - \`02-journals/\` — one file per weekly journal
  - \`03-monthly-reflection.md\`
  - \`04-kpis.md\` — multi-cycle KPI series
  - \`05-transcripts/\` — one file per Zoom transcript
  - \`06-additional-context.md\` — coach notes (only if present)
  - \`07-previous-reports/\` — prior cycles' coaching emails
  - \`08-prior-pattern-observations.md\`
  - \`09-curriculum-framework.md\`
  - \`10-resource-catalog.md\`

The model is instructed to return a single JSON object with the
coaching email and the structured monthly progress report. See
\`system-prompt.md\` for the exact schema.
`;
}

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

  const [copiedMain, setCopiedMain] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  async function copyMainPrompt() {
    if (!data) return;
    await navigator.clipboard.writeText(
      buildMainPrompt(data.systemPrompt, data.userPrompt),
    );
    setCopiedMain(true);
    setTimeout(() => setCopiedMain(false), 1500);
  }

  async function downloadBundle() {
    if (!data) return;
    setZipBusy(true);
    setZipError(null);
    try {
      const zip = new JSZip();
      const mainPrompt = buildMainPrompt(data.systemPrompt, data.userPrompt);
      zip.file('README.md', buildReadme({ ceoName, cycleLabel }));
      zip.file('main-prompt.md', mainPrompt);
      zip.file('system-prompt.md', data.systemPrompt);
      zip.file('user-prompt.md', data.userPrompt);
      for (const f of data.contextFiles) {
        zip.file(f.path, f.content);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const fileSlug = slugifyForFile(`${ceoName}-${cycleLabel}`);
      a.href = url;
      a.download = `coaching-prompt-${fileSlug}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setZipError(e instanceof Error ? e.message : 'Failed to build zip');
    } finally {
      setZipBusy(false);
    }
  }

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

        {data && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-5 py-3">
            <Button
              size="sm"
              variant="default"
              className="h-8"
              onClick={copyMainPrompt}
            >
              {copiedMain ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy main prompt
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={downloadBundle}
              disabled={zipBusy}
            >
              {zipBusy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Building zip…
                </>
              ) : (
                <>
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Download zip
                </>
              )}
            </Button>
            <p className="ml-1 text-[11px] text-muted-foreground">
              Run this generation in any off-platform LLM.
            </p>
            {zipError && (
              <p className="basis-full text-[11px] text-destructive">
                {zipError}
              </p>
            )}
          </div>
        )}

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
