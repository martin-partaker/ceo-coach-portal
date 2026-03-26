'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Copy,
  Check,
  Sparkles,
  Loader2,
  FileText,
  AlertTriangle,
  Mail,
} from 'lucide-react';

interface ReportViewProps {
  cycleId: string;
}

const SECTION_ORDER = [
  'opening',
  'wins_and_progress',
  'honest_feedback',
  'key_insight',
  'commitments',
  'closing',
] as const;

const SECTION_LABELS: Record<string, string> = {
  opening: 'Opening',
  wins_and_progress: 'Wins & Progress',
  honest_feedback: 'Honest Feedback',
  key_insight: 'Key Insight',
  commitments: 'Commitments',
  closing: 'Closing',
};

/** Convert markdown-ish text to simple HTML for rich-text clipboard */
function markdownToHtml(text: string): string {
  return text
    .split('\n\n')
    .map((block) => {
      // Convert **bold** to <strong>
      let html = block.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Convert *italic* to <em>
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
      // Convert lines starting with - or • to list items
      const lines = html.split('\n');
      const isList = lines.every((l) => /^[\s]*[-•]\s/.test(l) || l.trim() === '');
      if (isList && lines.some((l) => l.trim())) {
        const items = lines
          .filter((l) => l.trim())
          .map((l) => `<li>${l.replace(/^[\s]*[-•]\s*/, '')}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      // Convert numbered lines to ordered list
      const isNumbered = lines.every((l) => /^[\s]*\d+[.)]\s/.test(l) || l.trim() === '');
      if (isNumbered && lines.some((l) => l.trim())) {
        const items = lines
          .filter((l) => l.trim())
          .map((l) => `<li>${l.replace(/^[\s]*\d+[.)]\s*/, '')}</li>`)
          .join('');
        return `<ol>${items}</ol>`;
      }
      // Line breaks within a block
      html = html.replace(/\n/g, '<br>');
      return `<p>${html}</p>`;
    })
    .join('');
}

async function copyAsRichText(text: string) {
  const html = markdownToHtml(text);
  const blob = new Blob([html], { type: 'text/html' });
  const plainBlob = new Blob([text], { type: 'text/plain' });
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': blob,
      'text/plain': plainBlob,
    }),
  ]);
}

export function ReportView({ cycleId }: ReportViewProps) {
  const report = trpc.reports.getForCycle.useQuery({ cycleId });
  const generate = trpc.reports.generate.useMutation({
    onSuccess: () => {
      report.refetch();
    },
  });

  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSubject, setCopiedSubject] = useState(false);

  async function handleCopyAll() {
    if (!report.data?.rawText) return;
    await copyAsRichText(report.data.rawText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  }

  async function handleCopySubject() {
    const json = report.data?.contentJson as Record<string, string>;
    if (!json?.subject_line) return;
    await navigator.clipboard.writeText(json.subject_line);
    setCopiedSubject(true);
    setTimeout(() => setCopiedSubject(false), 2000);
  }

  if (report.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!report.data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <FileText className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-sm font-medium">No report generated yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Use the &quot;Generate Report&quot; button above when ready.
          </p>
        </CardContent>
      </Card>
    );
  }

  const contentJson = report.data.contentJson as Record<string, string>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-lg font-medium">Coaching Email</h2>
        <p className="text-xs text-muted-foreground font-mono">
          Generated {new Date(report.data.generatedAt).toLocaleString()}
        </p>
      </div>

      {/* Email preview */}
      <Card>
        <CardContent className="pt-6">
          {/* Action bar */}
          <div className="mb-4 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCopySubject}>
              {copiedSubject ? <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-500" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copiedSubject ? 'Copied!' : 'Copy subject'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCopyAll}>
              {copiedAll ? <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-500" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copiedAll ? 'Copied!' : 'Copy email body'}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => generate.mutate({ cycleId })}
              disabled={generate.isPending}
            >
              {generate.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
              Regenerate
            </Button>
          </div>

          {/* Subject line */}
          {contentJson.subject_line && (
            <>
              <Separator className="mb-4" />
              <div className="mb-4 flex items-center gap-2 min-w-0">
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-xs shrink-0 text-muted-foreground">Subject:</span>
                <span className="text-sm font-medium truncate">{contentJson.subject_line}</span>
              </div>
            </>
          )}
          <Separator className="mb-6" />

          {/* Email body */}
          <div className="space-y-4">
            {SECTION_ORDER.map((key) => {
              const content = contentJson[key];
              if (!content) return null;
              return (
                <div key={key} className="whitespace-pre-wrap text-sm leading-relaxed">
                  {content}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Section labels for coach reference */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">
          View section breakdown (coach reference only)
        </summary>
        <div className="mt-3 space-y-3">
          {SECTION_ORDER.map((key) => {
            const content = contentJson[key];
            if (!content) return null;
            return (
              <div key={key} className="rounded-lg border border-border p-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {SECTION_LABELS[key]}
                </p>
                <p className="whitespace-pre-wrap text-sm">{content}</p>
              </div>
            );
          })}
        </div>
      </details>

      {generate.error && (
        <Card className="border-destructive/20 bg-destructive/5">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-medium text-destructive">Generation failed</p>
              <p className="mt-1 text-muted-foreground">{generate.error.message}</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function GenerateReportButton({ cycleId, disabled }: { cycleId: string; disabled?: boolean }) {
  const utils = trpc.useUtils();
  const generate = trpc.reports.generate.useMutation({
    onSuccess: () => {
      utils.reports.getForCycle.invalidate({ cycleId });
    },
  });

  return (
    <Button
      size="sm"
      disabled={disabled || generate.isPending}
      onClick={() => generate.mutate({ cycleId })}
    >
      {generate.isPending ? (
        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="mr-1.5 h-4 w-4" />
      )}
      {generate.isPending ? 'Generating...' : 'Generate Report'}
    </Button>
  );
}
