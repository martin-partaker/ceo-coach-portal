'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';

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

const PROJECTABLE: ContentType[] = [
  'weekly_journal',
  'monthly_journal',
  'goal_worksheet',
  'intake',
];

export function InboxDiscoveredForms() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.inbox.listDiscoveredForms.useQuery();
  const [drafts, setDrafts] = useState<Record<string, ContentType>>({});

  const register = trpc.inbox.registerForm.useMutation({
    onSuccess: () => {
      utils.inbox.listDiscoveredForms.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    },
  });
  const ignore = trpc.inbox.ignoreForm.useMutation({
    onSuccess: () => {
      utils.inbox.listDiscoveredForms.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    },
  });
  const deactivate = trpc.inbox.deactivateForm.useMutation({
    onSuccess: () => {
      utils.inbox.listDiscoveredForms.invalidate();
      utils.inbox.pendingCounts.invalidate();
      utils.inbox.triageQueue.invalidate();
    },
  });

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin" />;
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No forms discovered yet.</p>;
  }

  return (
    <div className="space-y-2">
      {data.map((form) => {
        const draft = drafts[form.formId] ?? (form.contentType as ContentType);
        return (
          <Card key={form.formId} className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{form.name}</p>
                  <Badge
                    variant={
                      form.status === 'active'
                        ? 'default'
                        : form.status === 'ignored'
                        ? 'outline'
                        : 'secondary'
                    }
                    className="text-[10px]"
                  >
                    {form.status}
                  </Badge>
                  {form.contentType !== 'unknown' && (
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {form.contentType}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground font-mono">
                  formId: {form.formId}
                </p>
              </div>

              {form.status !== 'active' && (
                <div className="flex items-center gap-2">
                  <Select
                    value={draft}
                    onValueChange={(v) =>
                      setDrafts((s) => ({ ...s, [form.formId]: v as ContentType }))
                    }
                  >
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue placeholder="Pick content type…" />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTENT_TYPE_OPTIONS.map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    onClick={() =>
                      register.mutate({
                        formId: form.formId,
                        contentType: draft,
                        projectionEnabled: PROJECTABLE.includes(draft),
                      })
                    }
                    disabled={register.isPending}
                  >
                    Activate
                  </Button>
                  {form.status !== 'ignored' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => ignore.mutate({ formId: form.formId })}
                      disabled={ignore.isPending}
                    >
                      Ignore
                    </Button>
                  )}
                </div>
              )}
              {form.status === 'active' && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => deactivate.mutate({ formId: form.formId })}
                    disabled={deactivate.isPending}
                  >
                    Deactivate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => ignore.mutate({ formId: form.formId })}
                    disabled={ignore.isPending}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    Ignore
                  </Button>
                </div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
