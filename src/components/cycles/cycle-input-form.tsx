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
import {
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Save,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Cycle } from '@/db/schema';

interface CycleInputFormProps {
  cycle: Cycle;
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

export function CycleInputForm({ cycle }: CycleInputFormProps) {
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

  return (
    <div className="space-y-6">
      {/* Save indicator */}
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        {saving ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Saving...</span>
          </>
        ) : lastSaved ? (
          <>
            <Save className="h-3 w-3" />
            <span>Saved at {lastSaved}</span>
          </>
        ) : (
          <span>Auto-saves on edit</span>
        )}
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
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium">Weekly Journals</CardTitle>
            <Badge variant="secondary" className="text-[11px]">
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
            <CardTitle className="text-base font-medium">Zoom Transcript</CardTitle>
            {(isFilled(values.zoomTranscript) || values.transcriptSkipped) ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : (
              <Circle className="h-4 w-4 text-muted-foreground/40" />
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
              No transcript for this cycle (skip)
            </Label>
          </div>

          {!values.transcriptSkipped && (
            <>
              <p className="text-xs text-muted-foreground">
                Paste the Zoom meeting transcript below. Zoom integration coming soon.
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
        </CardContent>
      </Card>
    </div>
  );
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
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">{title}</CardTitle>
          {filled ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <Circle className="h-4 w-4 text-muted-foreground/40" />
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
