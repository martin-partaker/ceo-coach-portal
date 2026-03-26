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
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ZoomImportDialog } from '@/components/cycles/zoom-import-dialog';
import { GenerateReportButton } from '@/components/cycles/report-view';
import type { Cycle, JournalEntry, Transcript } from '@/db/schema';

interface CycleInputFormProps {
  cycle: Cycle;
  ceoId: string;
  ceoName: string;
  cycleLabel: string;
  hasZoomEmail: boolean;
  hasTenXGoal?: boolean;
  initialJournals: JournalEntry[];
  initialTranscripts: Transcript[];
}

export function CycleInputForm({ cycle, ceoId, ceoName, cycleLabel, hasZoomEmail, hasTenXGoal, initialJournals, initialTranscripts }: CycleInputFormProps) {
  const router = useRouter();

  const [values, setValues] = useState({
    monthlyGoals: cycle.monthlyGoals ?? '',
    monthlyReflection: cycle.monthlyReflection ?? '',
    transcriptSkipped: cycle.transcriptSkipped,
  });

  // Journal entries keyed by week number
  const [journals, setJournals] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    initialJournals.forEach((j) => { map[j.weekNumber] = j.content; });
    return map;
  });

  // Transcripts list
  const [transcriptList, setTranscriptList] = useState<Transcript[]>(initialTranscripts);

  const [aiSuggested, setAiSuggested] = useState<Set<string>>(() => {
    const set = new Set<string>();
    if (cycle.monthlyGoalsAiSuggested) set.add('monthlyGoals');
    if (cycle.monthlyReflectionAiSuggested) set.add('monthlyReflection');
    return set;
  });
  const [prefilling, setPrefilling] = useState(false);

  const prefillMutation = trpc.cycles.prefill.useMutation({
    onSuccess: (data) => {
      setValues((prev) => ({
        ...prev,
        monthlyGoals: data.monthlyGoals,
        monthlyReflection: data.monthlyReflection,
      }));
      setAiSuggested(new Set(['monthlyGoals', 'monthlyReflection']));
      setPrefilling(false);
      router.refresh();
    },
    onError: () => setPrefilling(false),
  });

  function triggerPrefill() {
    setPrefilling(true);
    prefillMutation.mutate({ cycleId: cycle.id });
  }

  // Clear AI-suggested badge when user edits a field
  function clearAiSuggested(field: string) {
    if (aiSuggested.has(field)) {
      setAiSuggested((prev) => {
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
      // Persist the clear to DB
      updateCycle.mutate({
        id: cycle.id,
        ...(field === 'monthlyGoals' && { monthlyGoalsAiSuggested: false }),
        ...(field === 'monthlyReflection' && { monthlyReflectionAiSuggested: false }),
      });
    }
  }

  const transcriptReady = transcriptList.length > 0 || values.transcriptSkipped;

  const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(() => {
    const expanded = new Set<number>();
    Object.keys(journals).forEach((k) => {
      if (journals[Number(k)]?.trim()) expanded.add(Number(k));
    });
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

  const upsertJournal = trpc.cycles.upsertJournal.useMutation({
    onSuccess: () => {
      setLastSaved(new Date().toLocaleTimeString());
      setSaving(null);
    },
    onError: () => setSaving(null),
  });

  function handleCycleFieldChange(field: 'monthlyGoals' | 'monthlyReflection', value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    clearAiSuggested(field);
    autoSave(field, value);
  }

  function handleJournalChange(weekNumber: number, value: string) {
    setJournals((prev) => ({ ...prev, [weekNumber]: value }));
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      setSaving(`journal-${weekNumber}`);
      upsertJournal.mutate({ cycleId: cycle.id, weekNumber, content: value });
    }, 800);
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

  const journalCount = Object.values(journals).filter((v) => isFilled(v)).length;
  const inputsFilled = [
    isFilled(values.monthlyGoals),
    journalCount > 0,
    isFilled(values.monthlyReflection),
    transcriptReady,
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


      {/* Step 1: Zoom Transcript (always first) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {transcriptReady ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
              ) : (
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">1</div>
              )}
              <CardTitle className="text-base font-medium">Zoom Transcript</CardTitle>
            </div>
            {!values.transcriptSkipped && (
              <ZoomImportDialog
                cycleId={cycle.id}
                ceoId={ceoId}
                hasZoomEmail={hasZoomEmail}
                existingTranscripts={transcriptList}
                onTranscriptsImported={(newTranscripts) => {
                  setTranscriptList((prev) => [...prev, ...newTranscripts]);
                  // Auto-trigger prefill after import
                  setTimeout(() => triggerPrefill(), 1000);
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
              {transcriptList.length > 0 ? (
                <div className="space-y-2">
                  {transcriptList.map((t) => (
                    <TranscriptCard key={t.id} transcript={t} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Import from Zoom using the button above.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Prefill loading state */}
      {prefilling && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-center gap-3 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm">Analyzing transcript and pre-filling fields...</span>
          </CardContent>
        </Card>
      )}

      {/* Gated content — locked until transcript is ready */}
      {!transcriptReady ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Circle className="h-8 w-8 text-muted-foreground/20" />
            <p className="mt-3 text-sm font-medium text-muted-foreground">Import a transcript to continue</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Session inputs will unlock after importing a Zoom transcript or marking as skipped.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Monthly Goals */}
          <InputSection
            title="Monthly Goals & Commitments"
            filled={isFilled(values.monthlyGoals)}
            description="What did the CEO commit to achieving this month?"
            aiSuggested={aiSuggested.has('monthlyGoals')}
          >
            <Textarea
              value={values.monthlyGoals}
              onChange={(e) => handleCycleFieldChange('monthlyGoals', e.target.value)}
              placeholder="Enter the CEO's monthly goals and commitments..."
              rows={5}
              className={cn(saving === 'monthlyGoals' && 'border-primary/50')}
            />
          </InputSection>

          {/* Weekly Journals */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                {journalCount > 0 ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                )}
                <CardTitle className="text-base font-medium">Weekly Journals</CardTitle>
                <Badge variant="secondary" className="ml-auto text-[11px]">
                  {journalCount} entries
                </Badge>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="space-y-2 pt-4">
              {[1, 2, 3, 4, 5].map((week) => {
                const value = journals[week] ?? '';
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
                          onChange={(e) => handleJournalChange(week, e.target.value)}
                          placeholder={`Week ${week} journal entry...`}
                          rows={4}
                          className={cn(saving === `journal-${week}` && 'border-primary/50')}
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
            aiSuggested={aiSuggested.has('monthlyReflection')}
          >
            <Textarea
              value={values.monthlyReflection}
              onChange={(e) => handleCycleFieldChange('monthlyReflection', e.target.value)}
              placeholder="Enter the CEO's monthly reflection..."
              rows={5}
              className={cn(saving === 'monthlyReflection' && 'border-primary/50')}
            />
          </InputSection>

          {/* Completion Summary */}
          <CompletionSummary values={values} hasTenXGoal={hasTenXGoal} cycleId={cycle.id} journalCount={journalCount} transcriptReady={transcriptReady} />
        </>
      )}
    </div>
  );
}

function CompletionSummary({ values, hasTenXGoal, cycleId, journalCount, transcriptReady }: { values: { monthlyGoals: string; monthlyReflection: string }; hasTenXGoal?: boolean; cycleId: string; journalCount: number; transcriptReady: boolean }) {
  const isFilled = (val: string) => val.trim().length > 0;

  const checks = [
    { label: '10x goal set', done: !!hasTenXGoal, required: true },
    { label: 'Monthly goals', done: isFilled(values.monthlyGoals), required: true },
    { label: 'At least one weekly journal', done: journalCount > 0, required: true },
    { label: 'Monthly reflection', done: isFilled(values.monthlyReflection), required: false },
    { label: 'Zoom transcript', done: transcriptReady, required: true },
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

function TranscriptCard({ transcript }: { transcript: Transcript }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          <div>
            <p className="text-sm font-medium">{transcript.title}</p>
            <p className="text-xs text-muted-foreground font-mono">
              {transcript.recordedAt
                ? new Date(transcript.recordedAt).toLocaleDateString()
                : new Date(transcript.createdAt).toLocaleDateString()}
              {transcript.duration ? ` · ${transcript.duration} min` : ''}
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono leading-relaxed">
            {transcript.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function InputSection({
  title,
  filled,
  description,
  aiSuggested,
  children,
}: {
  title: string;
  filled: boolean;
  description: string;
  aiSuggested?: boolean;
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
          {aiSuggested && (
            <Badge className="ml-auto bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 text-[10px]">
              <Sparkles className="mr-1 h-3 w-3" />
              AI-suggested
            </Badge>
          )}
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
