'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Copy,
  Check,
  Sparkles,
  Loader2,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ReportViewProps {
  cycleId: string;
}

const SECTION_ORDER = [
  'progress_summary',
  'key_wins',
  'challenges_constraints',
  'pattern_observations',
  'suggested_next_steps',
  'suggested_resources',
] as const;

const SECTION_TITLES: Record<string, string> = {
  progress_summary: 'Progress Summary',
  key_wins: 'Key Wins',
  challenges_constraints: 'Challenges & Constraints',
  pattern_observations: 'Pattern Observations',
  suggested_next_steps: 'Suggested Next Steps',
  suggested_resources: 'Suggested Resources',
};

export function ReportView({ cycleId }: ReportViewProps) {
  const report = trpc.reports.getForCycle.useQuery({ cycleId });
  const generate = trpc.reports.generate.useMutation({
    onSuccess: () => {
      report.refetch();
    },
  });

  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  async function handleCopy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopiedSection(key);
    setTimeout(() => setCopiedSection(null), 2000);
  }

  async function handleCopyAll() {
    if (!report.data?.rawText) return;
    await navigator.clipboard.writeText(report.data.rawText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
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

  // No report yet — show generate prompt
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
      {/* Report header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Coaching Report</h2>
          <p className="text-xs text-muted-foreground font-mono">
            Generated {new Date(report.data.generatedAt).toLocaleString()} &middot; {report.data.modelUsed}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCopyAll}>
            {copiedAll ? (
              <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <Copy className="mr-1.5 h-3.5 w-3.5" />
            )}
            {copiedAll ? 'Copied!' : 'Copy full report'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => generate.mutate({ cycleId })}
            disabled={generate.isPending}
          >
            {generate.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            Regenerate
          </Button>
        </div>
      </div>

      {/* Sections */}
      {SECTION_ORDER.map((key) => {
        const content = contentJson[key];
        if (!content) return null;

        return (
          <Card key={key}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {SECTION_TITLES[key]}
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleCopy(content, key)}
                >
                  {copiedSection === key ? (
                    <Check className="mr-1 h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="mr-1 h-3 w-3" />
                  )}
                  {copiedSection === key ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm leading-relaxed">
                {content}
              </div>
            </CardContent>
          </Card>
        );
      })}

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
