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
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileJson,
  Loader2,
  Wand2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * v2 "break out to LLM" inspector.
 *
 * Mirrors the v1 PromptInspector but loaded with everything the v2
 * pipeline produced — typed CycleFacts, Patterns, Critique, the
 * polished report — and a single self-contained "let's iterate" prompt
 * the coach can paste into Claude.ai / ChatGPT to refine the result.
 *
 * Surfaced as a "Break out to LLM" button in the modal footer.
 */

interface Props {
  cycleId: string;
  cycleLabel: string;
  ceoName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function slugifyForFile(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

function buildReadme({
  ceoName,
  cycleLabel,
  hasReport,
}: {
  ceoName: string;
  cycleLabel: string;
  hasReport: boolean;
}): string {
  return `# v2 coaching report — iteration bundle

CEO: **${ceoName}**
Cycle: **${cycleLabel}**
Exported: ${new Date().toISOString()}

This zip is the v2 pipeline's full output for this cycle PLUS a
"let's iterate" prompt you can paste into any off-platform LLM
(ChatGPT, Claude.ai, Gemini, etc.) to refine the report.

${
  hasReport
    ? ''
    : '> ⚠️ No v2 report has been generated for this cycle yet — the iteration prompt below uses the raw context only. Generate v2 first for a richer iteration session.\n\n'
}

## How to use

### Quick path (recommended)
1. Open \`iteration-prompt.md\` and copy the entire contents.
2. Paste into a new chat in your LLM of choice.
3. Send. The prompt is fully self-contained — it has the report, the
   typed facts, the cross-cycle patterns, the rubric critique, and
   every raw input.
4. Tell the LLM what you want to change.

### File-uploads path
If you prefer, upload everything under \`context/\` as attachments and
paste \`iteration-prompt.md\` as the message. Both paths work.

## What's inside

- \`iteration-prompt.md\` — the self-contained prompt. **This is the one
  to copy.**
- \`final-report.md\` — the polished v2 report rendered as markdown.
- \`final-report.json\` — the same report as the raw JSON contentJson.
- \`facts.json\` — Stage A typed CycleFacts (every claim has a sourceRef).
- \`patterns.json\` — Stage B cross-cycle patterns.
- \`critique.json\` — Stage D rubric scoring (pass/fail per item, topFix).
- \`context/\` — every raw input as its own file (journals, transcript,
  KPIs, monthly reflection, prior reports, curriculum framework,
  resource catalog).

The pipeline used these files to generate the report. The iteration
prompt explains all of this to the LLM and tells it how to help you
refine.
`;
}

export function V2IterationInspector({
  cycleId,
  cycleLabel,
  ceoName,
  open,
  onOpenChange,
}: Props) {
  const { data, isLoading, error } = trpc.reports.getV2IterationBundle.useQuery(
    { cycleId },
    { enabled: open, staleTime: 15_000 },
  );

  const [copied, setCopied] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  async function copyIterationPrompt() {
    if (!data) return;
    await navigator.clipboard.writeText(data.iterationPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function downloadZip() {
    if (!data) return;
    setZipBusy(true);
    setZipError(null);
    try {
      const zip = new JSZip();
      zip.file(
        'README.md',
        buildReadme({
          ceoName,
          cycleLabel,
          hasReport: !!data.finalReport,
        }),
      );
      zip.file('iteration-prompt.md', data.iterationPrompt);
      if (data.finalReport) {
        zip.file('final-report.json', JSON.stringify(data.finalReport, null, 2));
        zip.file('final-report.md', renderReportAsMarkdown(data.finalReport));
      }
      if (data.facts) zip.file('facts.json', JSON.stringify(data.facts, null, 2));
      if (data.patterns) zip.file('patterns.json', JSON.stringify(data.patterns, null, 2));
      if (data.critique) zip.file('critique.json', JSON.stringify(data.critique, null, 2));
      for (const f of data.contextFiles) {
        zip.file(f.path, f.content);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `v2-iteration-${slugifyForFile(`${ceoName}-${cycleLabel}`)}.zip`;
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
          <SheetTitle>Break out to LLM — {cycleLabel}</SheetTitle>
          <SheetDescription>
            Everything the v2 pipeline produced, plus a self-contained
            iteration prompt. Paste into Claude.ai / ChatGPT / Gemini
            and refine the report there with full context.
          </SheetDescription>
        </SheetHeader>

        {data && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-5 py-3">
            <Button
              size="sm"
              variant="default"
              className="h-8"
              onClick={copyIterationPrompt}
              disabled={isLoading}
            >
              {copied ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" /> Copied
                </>
              ) : (
                <>
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" /> Copy iteration prompt
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={downloadZip}
              disabled={zipBusy || isLoading}
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
              Refine this report in any LLM with full context.
            </p>
            {zipError && (
              <p className="basis-full text-[11px] text-destructive">{zipError}</p>
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
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>{error.message}</p>
            </div>
          )}
          {data && (
            <div className="space-y-4">
              <BundleStat
                hasReport={!!data.finalReport}
                hasFacts={!!data.facts}
                hasPatterns={!!data.patterns}
                hasCritique={!!data.critique}
                evidenceClaims={data.facts?.evidenceClaims?.length ?? 0}
                contextFiles={data.contextFiles.length}
                missing={data.missing}
              />

              <Section title="iteration-prompt.md" icon={<Wand2 className="h-3 w-3" />}>
                <Pre>{data.iterationPrompt}</Pre>
              </Section>

              {data.finalReport && (
                <Section
                  title="final-report.md"
                  icon={<FileJson className="h-3 w-3" />}
                >
                  <Pre>{renderReportAsMarkdown(data.finalReport)}</Pre>
                </Section>
              )}

              {data.facts && (
                <Section title="facts.json (Stage A)" icon={<FileJson className="h-3 w-3" />}>
                  <Pre>{JSON.stringify(data.facts, null, 2)}</Pre>
                </Section>
              )}
              {data.patterns && (
                <Section title="patterns.json (Stage B)" icon={<FileJson className="h-3 w-3" />}>
                  <Pre>{JSON.stringify(data.patterns, null, 2)}</Pre>
                </Section>
              )}
              {data.critique && (
                <Section title="critique.json (Stage D)" icon={<FileJson className="h-3 w-3" />}>
                  <Pre>{JSON.stringify(data.critique, null, 2)}</Pre>
                </Section>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BundleStat({
  hasReport,
  hasFacts,
  hasPatterns,
  hasCritique,
  evidenceClaims,
  contextFiles,
  missing,
}: {
  hasReport: boolean;
  hasFacts: boolean;
  hasPatterns: boolean;
  hasCritique: boolean;
  evidenceClaims: number;
  contextFiles: number;
  missing: string[];
}) {
  const items: Array<[label: string, ok: boolean, detail?: string]> = [
    ['Final report', hasReport],
    ['CycleFacts', hasFacts, `${evidenceClaims} evidence claims`],
    ['Patterns', hasPatterns],
    ['Critique', hasCritique],
    ['Context files', true, `${contextFiles}`],
  ];
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Bundle contents
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map(([label, ok, detail]) => (
          <span
            key={label}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px]',
              ok
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'bg-muted/60 text-muted-foreground line-through',
            )}
          >
            {ok ? '✓' : '✗'} {label}
            {detail ? ` (${detail})` : ''}
          </span>
        ))}
      </div>
      {missing.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
          ⚠ Missing inputs at generation time: {missing.join(', ')}
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-md border border-border bg-background">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
        {icon}
        {title}
        <span className="ml-auto text-[10px] opacity-60 group-open:hidden">show</span>
        <span className="ml-auto hidden text-[10px] opacity-60 group-open:inline">hide</span>
      </summary>
      <div className="border-t border-border bg-muted/20 p-3">{children}</div>
    </details>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground/90">
      {children}
    </pre>
  );
}

// ── markdown renderer (mirrors the server-side one in iteration-bundle.ts
//    so the inspector can show the same content without a roundtrip) ────

type ReportShape = {
  report?: {
    progressSummary?: string;
    keyWins?: string[];
    challenges?: string[];
    patternObservations?: string;
    suggestedNextSteps?: string[];
    goalSummary?: {
      tenX?: string;
      ninetyDay?: string | null;
      thirtyDay?: string | null;
      flag?: string | null;
    } | null;
    coachReviewFlags?: Array<{
      title: string;
      detail: string;
      urgency?: 'info' | 'attention' | 'urgent';
    }>;
  };
};

function renderReportAsMarkdown(d: ReportShape): string {
  const r = d.report ?? {};
  const parts: string[] = [];
  if (r.goalSummary) {
    parts.push('### 1. Goal Summary');
    if (r.goalSummary.tenX) parts.push(`- **10x Goal:** ${r.goalSummary.tenX}`);
    if (r.goalSummary.ninetyDay) parts.push(`- **90-Day Goal:** ${r.goalSummary.ninetyDay}`);
    if (r.goalSummary.thirtyDay) parts.push(`- **30-Day Goal:** ${r.goalSummary.thirtyDay}`);
    if (r.goalSummary.flag) parts.push(`\n> ⚑ **Flag for Coach Review:** ${r.goalSummary.flag}`);
    parts.push('');
  }
  if (r.progressSummary) {
    parts.push('### 2. Progress Summary');
    parts.push(r.progressSummary);
    parts.push('');
  }
  if (r.keyWins && r.keyWins.length > 0) {
    parts.push('### 3. Key Wins');
    for (const w of r.keyWins) parts.push(`- ${w}`);
    parts.push('');
  }
  if (r.challenges && r.challenges.length > 0) {
    parts.push('### 4. Challenges & Patterns');
    for (const c of r.challenges) parts.push(`- ${c}`);
    parts.push('');
  }
  if (r.patternObservations) {
    parts.push('### 5. Pattern Observations');
    parts.push(r.patternObservations);
    parts.push('');
  }
  if (r.suggestedNextSteps && r.suggestedNextSteps.length > 0) {
    parts.push('### 6. Recommended Next Steps');
    r.suggestedNextSteps.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
    parts.push('');
  }
  if (r.coachReviewFlags && r.coachReviewFlags.length > 0) {
    parts.push('### Coach review flags (visible to coach only)');
    for (const f of r.coachReviewFlags) {
      parts.push(`- **[${(f.urgency ?? 'attention').toUpperCase()}] ${f.title}** — ${f.detail}`);
    }
  }
  return parts.join('\n');
}
