'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Save,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ZoomImportDialog } from '@/components/cycles/zoom-import-dialog';
import { GenerateReportButton } from '@/components/cycles/report-view';
import type { Cycle } from '@/db/schema';

interface CycleInputFormProps {
  cycle: Cycle;
  ceoId: string;
  ceoName: string;
  cycleLabel: string;
  hasZoomEmail: boolean;
  hasTenXGoal?: boolean;
}

type CycleField = keyof Pick<
  Cycle,
  | 'monthlyGoals'
  | 'weeklyJournal1'
  | 'weeklyJournal2'
  | 'weeklyJournal3'
  | 'weeklyJournal4'
  | 'weeklyJournal5'
  | 'monthlyReflection'
  | 'zoomTranscript'
  | 'transcriptSkipped'
>;

export function CycleInputForm({ cycle, ceoId, ceoName, cycleLabel, hasZoomEmail, hasTenXGoal }: CycleInputFormProps) {
  const router = useRouter();

  const [values, setValues] = useState({
    monthlyGoals: cycle.monthlyGoals ?? '',
    weeklyJournal1: cycle.weeklyJournal1 ?? '',
    weeklyJournal2: cycle.weeklyJournal2 ?? '',
    weeklyJournal3: cycle.weeklyJournal3 ?? '',
    weeklyJournal4: cycle.weeklyJournal4 ?? '',
    weeklyJournal5: cycle.weeklyJournal5 ?? '',
    monthlyReflection: cycle.monthlyReflection ?? '',
    zoomTranscript: cycle.zoomTranscript ?? '',
    transcriptSkipped: cycle.transcriptSkipped,
  });

  const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(() => {
    // Auto-expand weeks that have content
    const expanded = new Set<number>();
    for (let i = 1; i <= 5; i++) {
      const key = `weeklyJournal${i}` as CycleField;
      if (cycle[key] && String(cycle[key]).trim()) {
        expanded.add(i);
      }
    }
    // Always expand at least week 1 if none have content
    if (expanded.size === 0) expanded.add(1);
    return expanded;
  });

  const [saving, setSaving] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const updateCycle = trpc.cycles.update.useMutation({
    onSuccess: () => {
      setLastSaved(new Date().toLocaleTimeString());
      setSaving(null);
      router.refresh();
    },
    onError: () => {
      setSaving(null);
    },
  });

  const autoSave = useCallback(
    (field: string, value: string | boolean) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

      saveTimeoutRef.current = setTimeout(() => {
        setSaving(field);
        updateCycle.mutate({
          id: cycle.id,
          [field]: typeof value === 'string' ? (value.trim() || null) : value,
        });
      }, 800);
    },
    [cycle.id, updateCycle]
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  function handleTextChange(field: CycleField, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    autoSave(field, value);
  }

  function handleCheckboxChange(checked: boolean) {
    setValues((prev) => ({ ...prev, transcriptSkipped: checked }));
    setSaving('transcriptSkipped');
    updateCycle.mutate({
      id: cycle.id,
      transcriptSkipped: checked,
    });
  }

  function toggleWeek(week: number) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(week)) next.delete(week);
      else next.add(week);
      return next;
    });
  }

  const isFilled = (val: string) => val.trim().length > 0;

  const inputsFilled = [
    isFilled(values.monthlyGoals),
    isFilled(values.weeklyJournal1),
    isFilled(values.weeklyJournal2),
    isFilled(values.weeklyJournal3),
    isFilled(values.weeklyJournal4),
    isFilled(values.weeklyJournal5),
    isFilled(values.monthlyReflection),
    isFilled(values.zoomTranscript) || values.transcriptSkipped,
  ];
  const filledCount = inputsFilled.filter(Boolean).length;
  const totalInputs = inputsFilled.length;

  return (
    <div className="space-y-6">
      {/* Sticky header with live progress */}
      <div className="sticky top-0 z-10 -mx-6 border-b border-border bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{cycleLabel}</h1>
            <p className="text-xs text-muted-foreground">Session period for {ceoName}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Save status */}
            <span className="text-[11px] text-muted-foreground">
              {saving ? 'Saving...' : lastSaved ? `Saved ${lastSaved}` : ''}
            </span>
            {/* Progress badge */}
            <Badge
              variant="secondary"
              className={cn(
                'text-xs',
                filledCount === totalInputs && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
              )}
            >
              {filledCount}/{totalInputs} inputs
            </Badge>
          </div>
        </div>
      </div>


      {/* Monthly Goals */}
      <InputSection
        title="Monthly Goals & Commitments"
        filled={isFilled(values.monthlyGoals)}
        description="What did the CEO commit to achieving this month?"
      >
        <Textarea
          value={values.monthlyGoals}
          onChange={(e) => handleTextChange('monthlyGoals', e.target.value)}
          placeholder="Enter the CEO's monthly goals and commitments..."
          rows={5}
          className={cn(saving === 'monthlyGoals' && 'border-primary/50')}
        />
      </InputSection>

      {/* Weekly Journals */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            {[1, 2, 3, 4, 5].some((w) => isFilled(values[`weeklyJournal${w}` as keyof typeof values] as string)) ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            )}
            <CardTitle className="text-base font-medium">Weekly Journals</CardTitle>
            <Badge variant="secondary" className="ml-auto text-[11px]">
              {[1, 2, 3, 4, 5].filter((w) => isFilled(values[`weeklyJournal${w}` as keyof typeof values] as string)).length}/5
            </Badge>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-2 pt-4">
          {[1, 2, 3, 4, 5].map((week) => {
            const field = `weeklyJournal${week}` as CycleField;
            const value = values[field] as string;
            const expanded = expandedWeeks.has(week);
            const filled = isFilled(value);

            return (
              <div key={week} className="rounded-lg border border-border">
                <button
                  type="button"
                  onClick={() => toggleWeek(week)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-center gap-3">
                    {filled ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground/40" />
                    )}
                    <span className="text-sm font-medium">Week {week}</span>
                  </div>
                  {expanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                {expanded && (
                  <div className="border-t border-border px-4 py-3">
                    <Textarea
                      value={value}
                      onChange={(e) => handleTextChange(field, e.target.value)}
                      placeholder={`Week ${week} journal entry...`}
                      rows={4}
                      className={cn(saving === field && 'border-primary/50')}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Monthly Reflection */}
      <InputSection
        title="Monthly Reflection"
        filled={isFilled(values.monthlyReflection)}
        description="CEO's reflection on the month — wins, struggles, learnings."
      >
        <Textarea
          value={values.monthlyReflection}
          onChange={(e) => handleTextChange('monthlyReflection', e.target.value)}
          placeholder="Enter the CEO's monthly reflection..."
          rows={5}
          className={cn(saving === 'monthlyReflection' && 'border-primary/50')}
        />
      </InputSection>

      {/* Zoom Transcript */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {(isFilled(values.zoomTranscript) || values.transcriptSkipped) ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
              )}
              <CardTitle className="text-base font-medium">Zoom Transcript</CardTitle>
            </div>
            {!values.transcriptSkipped && (
              <ZoomImportDialog
                cycleId={cycle.id}
                ceoId={ceoId}
                hasZoomEmail={hasZoomEmail}
                existingTranscript={values.zoomTranscript}
                onTranscriptImported={(transcript) => {
                  setValues((prev) => ({ ...prev, zoomTranscript: transcript }));
                  autoSave('zoomTranscript', transcript);
                }}
              />
            )}
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-4 pt-4">
          <div className="flex items-center gap-3">
            <Checkbox
              id="transcript-skipped"
              checked={values.transcriptSkipped}
              onCheckedChange={(checked) => handleCheckboxChange(checked === true)}
            />
            <Label
              htmlFor="transcript-skipped"
              className="text-sm font-normal text-muted-foreground cursor-pointer"
            >
              No transcript for this session (skip)
            </Label>
          </div>

          {!values.transcriptSkipped && (
            <>
              {isFilled(values.zoomTranscript) ? (
                <TranscriptCards
                  transcript={values.zoomTranscript}
                  onEdit={(text) => handleTextChange('zoomTranscript', text)}
                />
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Import from Zoom or paste the transcript manually below.
                  </p>
                  <Textarea
                    value={values.zoomTranscript}
                    onChange={(e) => handleTextChange('zoomTranscript', e.target.value)}
                    placeholder="Paste transcript here..."
                    rows={8}
                    className={cn(
                      'font-mono text-xs',
                      saving === 'zoomTranscript' && 'border-primary/50'
                    )}
                  />
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Completion Summary */}
      <CompletionSummary values={values} hasTenXGoal={hasTenXGoal} cycleId={cycle.id} />
    </div>
  );
}

function CompletionSummary({ values, hasTenXGoal, cycleId }: { values: { monthlyGoals: string; weeklyJournal1: string; weeklyJournal2: string; weeklyJournal3: string; weeklyJournal4: string; weeklyJournal5: string; monthlyReflection: string; zoomTranscript: string; transcriptSkipped: boolean }; hasTenXGoal?: boolean; cycleId: string }) {
  const isFilled = (val: string) => val.trim().length > 0;

  const checks = [
    { label: '10x goal set', done: !!hasTenXGoal, required: true },
    { label: 'Monthly goals', done: isFilled(values.monthlyGoals), required: true },
    { label: 'At least one weekly journal', done: [values.weeklyJournal1, values.weeklyJournal2, values.weeklyJournal3, values.weeklyJournal4, values.weeklyJournal5].some((j) => isFilled(j)), required: true },
    { label: 'Monthly reflection', done: isFilled(values.monthlyReflection), required: false },
    { label: 'Zoom transcript', done: isFilled(values.zoomTranscript) || values.transcriptSkipped, required: true },
  ];

  const requiredDone = checks.filter((c) => c.required && c.done).length;
  const requiredTotal = checks.filter((c) => c.required).length;
  const allRequiredDone = requiredDone === requiredTotal;
  const allDone = checks.every((c) => c.done);

  return (
    <Card className={allRequiredDone ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}>
      <CardContent className="py-6">
        <div className="flex items-start gap-4">
          <div className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            allRequiredDone ? 'bg-emerald-500/10' : 'bg-amber-500/10'
          )}>
            {allRequiredDone ? (
              <Sparkles className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            )}
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium">
              {allRequiredDone
                ? allDone
                  ? 'All inputs complete'
                  : 'Ready to generate (optional inputs missing)'
                : 'Missing required inputs'}
            </h3>
            <div className="mt-3 space-y-1.5">
              {checks.map(({ label, done, required }) => (
                <div key={label} className="flex items-center gap-2">
                  {done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
                  )}
                  <span className={cn('text-xs', done ? 'text-muted-foreground' : 'text-foreground')}>
                    {label}
                    {!required && <span className="text-muted-foreground"> (optional)</span>}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <GenerateReportButton cycleId={cycleId} disabled={!allRequiredDone} />
              {!allRequiredDone && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Complete the required inputs above to generate.
                </p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TranscriptCards({ transcript, onEdit }: { transcript: string; onEdit: (text: string) => void }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [showRawEdit, setShowRawEdit] = useState(false);

  // Parse sections separated by === headers ===
  const sections = parseTranscriptSections(transcript);

  if (showRawEdit) {
    return (
      <div className="space-y-3">
        <Textarea
          value={transcript}
          onChange={(e) => onEdit(e.target.value)}
          rows={12}
          className="font-mono text-xs"
        />
        <Button variant="outline" size="sm" onClick={() => setShowRawEdit(false)}>
          Done editing
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sections.map((section, i) => (
        <div key={i} className="rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
            className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/50"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
              <div>
                <p className="text-sm font-medium">{section.title}</p>
                {section.meta && (
                  <p className="text-xs text-muted-foreground font-mono">{section.meta}</p>
                )}
              </div>
            </div>
            {expandedIndex === i ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {expandedIndex === i && (
            <div className="border-t border-border px-4 py-3">
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono leading-relaxed">
                {section.content.trim()}
              </pre>
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center gap-3 pt-1">
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setShowRawEdit(true)}>
          Edit raw transcript
        </Button>
        <Button variant="ghost" size="sm" className="text-xs text-destructive" onClick={() => onEdit('')}>
          Clear all
        </Button>
      </div>
    </div>
  );
}

function parseTranscriptSections(transcript: string): { title: string; meta: string; content: string }[] {
  const headerRegex = /^===\s*(.+?)\s*\(([^)]+)\)\s*===$/gm;
  const sections: { title: string; meta: string; content: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = headerRegex.exec(transcript)) !== null) {
    // If there's content before the first header, add it as "Pasted transcript"
    if (sections.length === 0 && match.index > 0) {
      const before = transcript.slice(0, match.index).trim();
      if (before) sections.push({ title: 'Pasted transcript', meta: '', content: before });
    }
    // Save start of this section's content
    if (sections.length > 0) {
      sections[sections.length - 1].content = transcript.slice(lastIndex, match.index);
    }
    sections.push({ title: match[1], meta: match[2], content: '' });
    lastIndex = match.index + match[0].length;
  }

  // Remaining content goes to last section
  if (sections.length > 0) {
    sections[sections.length - 1].content = transcript.slice(lastIndex);
  } else {
    // No headers found — show as single block
    sections.push({ title: 'Transcript', meta: '', content: transcript });
  }

  return sections;
}

function InputSection({
  title,
  filled,
  description,
  children,
}: {
  title: string;
  filled: boolean;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          {filled ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          ) : (
            <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
          )}
          <CardTitle className="text-base font-medium">{title}</CardTitle>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="space-y-2 pt-4">
        <p className="text-xs text-muted-foreground">{description}</p>
        {children}
      </CardContent>
    </Card>
  );
}
