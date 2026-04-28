'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  EyeOff,
  Loader2,
  Pause,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ContentType =
  | 'intake'
  | 'goal_worksheet'
  | 'monthly_journal'
  | 'weekly_journal'
  | 'self_assessment'
  | 'support_feedback'
  | 'coach_note'
  | 'fallback_doc'
  | 'unknown';

const CONTENT_TYPE_OPTIONS: ContentType[] = [
  'weekly_journal',
  'monthly_journal',
  'goal_worksheet',
  'intake',
  'self_assessment',
  'support_feedback',
  'coach_note',
  'fallback_doc',
  'unknown',
];

/** Full-form labels for the Integrations page. The shared roster
 *  CONTENT_TYPE_LABEL map intentionally uses shorter names ("Weekly",
 *  "Monthly", "10x") for the timeline legend; here we want plain English
 *  for the operator picking what a form is for. */
const CONTENT_TYPE_LABEL_LONG: Record<ContentType, string> = {
  weekly_journal: 'Weekly journal',
  monthly_journal: 'Monthly journal',
  goal_worksheet: '10x goal worksheet',
  intake: 'Intake form',
  self_assessment: 'Self-assessment',
  support_feedback: 'Support / feedback',
  coach_note: 'Coach note',
  fallback_doc: 'Other document',
  unknown: 'Pick a content type…',
};

/** Whether picking this content type should auto-project the submission
 *  into a journal/transcript/etc. The list mirrors PROJECTABLE in the
 *  ingestion pipeline. */
const PROJECTABLE: ContentType[] = [
  'weekly_journal',
  'monthly_journal',
  'goal_worksheet',
  'intake',
];

type FormStatus = 'pending_review' | 'active' | 'ignored';

interface DiscoveredForm {
  formId: string;
  name: string;
  status: string;
  contentType: string;
  projectionEnabled: boolean;
  updatedAt: Date;
}

export function InboxDiscoveredForms() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.inbox.listDiscoveredForms.useQuery();
  const [drafts, setDrafts] = useState<Record<string, ContentType>>({});

  const invalidateAll = () => {
    utils.inbox.listDiscoveredForms.invalidate();
    utils.inbox.pendingCounts.invalidate();
    utils.inbox.triageQueue.invalidate();
  };

  const register = trpc.inbox.registerForm.useMutation({ onSuccess: invalidateAll });
  const ignore = trpc.inbox.ignoreForm.useMutation({ onSuccess: invalidateAll });
  const deactivate = trpc.inbox.deactivateForm.useMutation({ onSuccess: invalidateAll });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading forms…
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
        No forms discovered yet. Click <span className="font-medium">Sync now</span> above
        to pull the latest list from Tally.
      </p>
    );
  }

  const pending = data.filter((f) => f.status === 'pending_review');
  const active = data.filter((f) => f.status === 'active');
  const ignored = data.filter((f) => f.status === 'ignored');

  return (
    <div className="space-y-6">
      {pending.length > 0 && (
        <FormsSection
          title="Needs your decision"
          description="These forms exist on Tally but haven't been set up yet. Pick what kind of content each one is, then activate it to start ingesting submissions — or ignore it to drop them silently."
          tone="amber"
          count={pending.length}
        >
          {pending.map((form) => (
            <PendingFormRow
              key={form.formId}
              form={form}
              draft={drafts[form.formId] ?? (form.contentType as ContentType)}
              onDraftChange={(v) =>
                setDrafts((s) => ({ ...s, [form.formId]: v }))
              }
              onActivate={(contentType) =>
                register.mutate({
                  formId: form.formId,
                  contentType,
                  projectionEnabled: PROJECTABLE.includes(contentType),
                })
              }
              onIgnore={() => ignore.mutate({ formId: form.formId })}
              busy={register.isPending || ignore.isPending}
            />
          ))}
        </FormsSection>
      )}

      {active.length > 0 && (
        <FormsSection
          title="Active"
          description="These forms are live — every new submission lands in Triage to be assigned to a CEO."
          tone="green"
          count={active.length}
        >
          {active.map((form) => (
            <ActiveFormRow
              key={form.formId}
              form={form}
              onDeactivate={() => deactivate.mutate({ formId: form.formId })}
              onIgnore={() => ignore.mutate({ formId: form.formId })}
              busy={deactivate.isPending || ignore.isPending}
            />
          ))}
        </FormsSection>
      )}

      {ignored.length > 0 && (
        <FormsSection
          title="Ignored"
          description="Submissions to these forms are dropped silently. Reactivate one if you change your mind."
          tone="muted"
          count={ignored.length}
          collapsible
        >
          {ignored.map((form) => (
            <IgnoredFormRow
              key={form.formId}
              form={form}
              draft={drafts[form.formId] ?? (form.contentType as ContentType)}
              onDraftChange={(v) =>
                setDrafts((s) => ({ ...s, [form.formId]: v }))
              }
              onActivate={(contentType) =>
                register.mutate({
                  formId: form.formId,
                  contentType,
                  projectionEnabled: PROJECTABLE.includes(contentType),
                })
              }
              busy={register.isPending}
            />
          ))}
        </FormsSection>
      )}
    </div>
  );
}

/* ─────────────────── Section + row primitives ─────────────────── */

function FormsSection({
  title,
  description,
  tone,
  count,
  collapsible,
  children,
}: {
  title: string;
  description: string;
  tone: 'amber' | 'green' | 'muted';
  count: number;
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  const toneClass: Record<typeof tone, string> = {
    amber:
      'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
    green:
      'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
    muted: 'border-border bg-muted/30 text-muted-foreground',
  };
  return (
    <section>
      <div
        className={cn(
          'mb-2 flex items-start justify-between gap-3 rounded-md border px-3 py-2',
          toneClass[tone],
        )}
      >
        <div className="min-w-0">
          <button
            type="button"
            disabled={!collapsible}
            onClick={() => setOpen((o) => !o)}
            className={cn(
              'flex items-center gap-1.5 text-sm font-semibold',
              collapsible && 'cursor-pointer',
            )}
          >
            {collapsible &&
              (open ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              ))}
            {title}
            <span className="ml-1 rounded-full border border-current/30 bg-background/60 px-1.5 text-[11px] font-medium">
              {count}
            </span>
          </button>
          <p className="mt-0.5 text-[12px] leading-snug opacity-80">
            {description}
          </p>
        </div>
      </div>
      {open && <div className="space-y-2">{children}</div>}
    </section>
  );
}

function FormRowShell({
  form,
  badge,
  children,
}: {
  form: DiscoveredForm;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{form.name}</p>
            {badge}
          </div>
          <FormDetails formId={form.formId} />
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

function FormDetails({ formId }: { formId: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
      >
        {open ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
        Details
      </button>
      {open && (
        <div className="mt-1 flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          <span>formId:</span>
          <code className="rounded bg-muted px-1 py-0.5">{formId}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(formId);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="text-muted-foreground/70 hover:text-foreground"
            aria-label="Copy formId"
          >
            {copied ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function PendingFormRow({
  form,
  draft,
  onDraftChange,
  onActivate,
  onIgnore,
  busy,
}: {
  form: DiscoveredForm;
  draft: ContentType;
  onDraftChange: (v: ContentType) => void;
  onActivate: (contentType: ContentType) => void;
  onIgnore: () => void;
  busy: boolean;
}) {
  return (
    <FormRowShell
      form={form}
      badge={
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
          <CircleHelp className="h-3 w-3" /> Needs decision
        </span>
      }
    >
      <ContentTypeSelect value={draft} onValueChange={onDraftChange} />
      <Button
        size="sm"
        onClick={() => onActivate(draft)}
        disabled={busy || draft === 'unknown'}
      >
        <Play className="mr-1 h-3 w-3" /> Activate
      </Button>
      <Button size="sm" variant="outline" onClick={onIgnore} disabled={busy}>
        <EyeOff className="mr-1 h-3 w-3" /> Ignore
      </Button>
    </FormRowShell>
  );
}

function ActiveFormRow({
  form,
  onDeactivate,
  onIgnore,
  busy,
}: {
  form: DiscoveredForm;
  onDeactivate: () => void;
  onIgnore: () => void;
  busy: boolean;
}) {
  const label =
    CONTENT_TYPE_LABEL_LONG[form.contentType as ContentType] ?? form.contentType;
  return (
    <FormRowShell
      form={form}
      badge={
        <>
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" /> Active
          </span>
          <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-foreground/80">
            {label}
          </span>
          {form.projectionEnabled && (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              auto-projected
            </span>
          )}
        </>
      }
    >
      <Button size="sm" variant="outline" onClick={onDeactivate} disabled={busy}>
        <Pause className="mr-1 h-3 w-3" /> Pause
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onIgnore}
        disabled={busy}
        className="text-muted-foreground hover:text-destructive"
      >
        <EyeOff className="mr-1 h-3 w-3" /> Ignore
      </Button>
    </FormRowShell>
  );
}

function IgnoredFormRow({
  form,
  draft,
  onDraftChange,
  onActivate,
  busy,
}: {
  form: DiscoveredForm;
  draft: ContentType;
  onDraftChange: (v: ContentType) => void;
  onActivate: (contentType: ContentType) => void;
  busy: boolean;
}) {
  return (
    <FormRowShell
      form={form}
      badge={
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
          <EyeOff className="h-3 w-3" /> Ignored
        </span>
      }
    >
      <ContentTypeSelect value={draft} onValueChange={onDraftChange} />
      <Button
        size="sm"
        variant="outline"
        onClick={() => onActivate(draft)}
        disabled={busy || draft === 'unknown'}
      >
        <Play className="mr-1 h-3 w-3" /> Reactivate
      </Button>
    </FormRowShell>
  );
}

function ContentTypeSelect({
  value,
  onValueChange,
}: {
  value: ContentType;
  onValueChange: (v: ContentType) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as ContentType)}>
      <SelectTrigger className="h-8 w-52 text-xs">
        <SelectValue placeholder="Pick a content type…" />
      </SelectTrigger>
      <SelectContent>
        {CONTENT_TYPE_OPTIONS.map((t) => (
          <SelectItem key={t} value={t} className="text-xs">
            {CONTENT_TYPE_LABEL_LONG[t]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
