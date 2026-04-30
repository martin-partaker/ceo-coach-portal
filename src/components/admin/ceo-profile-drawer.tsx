'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  ArrowRightLeft,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  ceo: {
    id: string;
    name: string;
    email: string | null;
    avatarUrl: string | null;
    tenXGoal: string | null;
    /** Null when the CEO is in the Unassigned bucket. */
    coachId: string | null;
    aliasEmails: string[];
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReassign?: () => void;
  onDelete?: () => void;
}

export function CeoProfileDrawer({
  ceo,
  open,
  onOpenChange,
  onReassign,
  onDelete,
}: Props) {
  const utils = trpc.useUtils();

  const [name, setName] = useState(ceo.name);
  const [email, setEmail] = useState(ceo.email ?? '');
  const [avatarUrl, setAvatarUrl] = useState(ceo.avatarUrl ?? '');
  const [tenXGoal, setTenXGoal] = useState(ceo.tenXGoal ?? '');
  const [newAlias, setNewAlias] = useState('');

  // Re-seed when the drawer opens for a different CEO or reopens fresh.
  useEffect(() => {
    if (open) {
      setName(ceo.name);
      setEmail(ceo.email ?? '');
      setAvatarUrl(ceo.avatarUrl ?? '');
      setTenXGoal(ceo.tenXGoal ?? '');
      setNewAlias('');
    }
  }, [open, ceo.id, ceo.name, ceo.email, ceo.avatarUrl, ceo.tenXGoal]);

  const update = trpc.admin.updateCeo.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      utils.roster.cycleSummary.invalidate();
    },
  });
  const addAlias = trpc.admin.addCeoAlias.useMutation({
    onSuccess: () => {
      setNewAlias('');
      utils.admin.listAllCeos.invalidate();
      utils.roster.cycleSummary.invalidate();
    },
  });
  const removeAlias = trpc.admin.removeCeoAlias.useMutation({
    onSuccess: () => {
      utils.admin.listAllCeos.invalidate();
      utils.roster.cycleSummary.invalidate();
    },
  });

  const dirty =
    name.trim() !== ceo.name ||
    (email.trim() || null) !== ceo.email ||
    (avatarUrl.trim() || null) !== ceo.avatarUrl ||
    (tenXGoal.trim() || null) !== ceo.tenXGoal;

  function save() {
    update.mutate({
      ceoId: ceo.id,
      name: name.trim(),
      email: email.trim() || null,
      avatarUrl: avatarUrl.trim() || null,
      tenXGoal: tenXGoal.trim() || null,
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader className="flex-row items-center gap-3">
          <CeoAvatar name={ceo.name} avatarUrl={ceo.avatarUrl} size="sm" />
          <div className="min-w-0">
            <SheetTitle className="truncate">Edit profile</SheetTitle>
            <SheetDescription className="truncate">
              {ceo.name}
              {ceo.email ? ` · ${ceo.email}` : ''}
            </SheetDescription>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          <Section title="Identity">
            <div className="space-y-3">
              <Field label="Name" htmlFor="cp-name">
                <Input
                  id="cp-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Primary email" htmlFor="cp-email">
                <Input
                  id="cp-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="(no email)"
                />
              </Field>
              <Field label="Avatar URL" htmlFor="cp-avatar">
                <Input
                  id="cp-avatar"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="https://…"
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Email aliases"
            sub={`${ceo.aliasEmails.length} linked`}
          >
            <div className="space-y-1.5">
              {ceo.aliasEmails.length === 0 && (
                <p className="rounded border border-dashed border-border bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
                  No aliases yet. Submissions sent from any email here will be
                  attached to this CEO automatically.
                </p>
              )}
              {ceo.aliasEmails.map((a) => {
                const isPrimary = a === ceo.email;
                return (
                  <div
                    key={a}
                    className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
                  >
                    <span className="flex-1 truncate font-mono text-xs">
                      {a}
                    </span>
                    {isPrimary && (
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                        primary
                      </span>
                    )}
                    {!isPrimary && (
                      <button
                        type="button"
                        onClick={() =>
                          removeAlias.mutate({ ceoId: ceo.id, email: a })
                        }
                        disabled={removeAlias.isPending}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        aria-label={`Remove alias ${a}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newAlias.trim()) return;
                  addAlias.mutate({ ceoId: ceo.id, email: newAlias.trim() });
                }}
                className="flex items-center gap-2 pt-1"
              >
                <Input
                  type="email"
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  placeholder="add another email…"
                  className="h-8 text-xs"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={addAlias.isPending || !newAlias.trim()}
                >
                  {addAlias.isPending ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-3 w-3" />
                  )}
                  Add
                </Button>
              </form>
              {addAlias.error && (
                <p className="text-xs text-destructive">{addAlias.error.message}</p>
              )}
              {removeAlias.error && (
                <p className="text-xs text-destructive">{removeAlias.error.message}</p>
              )}
            </div>
          </Section>

          <Section title="10x goal">
            <Textarea
              value={tenXGoal}
              onChange={(e) => setTenXGoal(e.target.value)}
              rows={4}
              placeholder="e.g. Scale KoreTrust to $50M ARR within 3 years"
              className="text-sm leading-relaxed"
            />
          </Section>

          {(onReassign || onDelete) && (
            <Section title="Danger" tone="destructive">
              <div className="flex flex-wrap gap-2">
                {onReassign && (
                  <Button size="sm" variant="outline" onClick={onReassign}>
                    <ArrowRightLeft className="mr-1.5 h-3 w-3" />
                    Reassign coach
                  </Button>
                )}
                {onDelete && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={onDelete}
                  >
                    <Trash2 className="mr-1.5 h-3 w-3" />
                    Delete CEO
                  </Button>
                )}
              </div>
            </Section>
          )}
        </div>

        <SheetFooter className="flex-row items-center gap-2">
          {update.error && (
            <p className="flex-1 truncate text-xs text-destructive">
              {update.error.message}
            </p>
          )}
          <span className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!dirty || update.isPending || !name.trim()}>
            {update.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  sub,
  tone = 'default',
  children,
}: {
  title: string;
  sub?: string;
  tone?: 'default' | 'destructive';
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <Label
          className={cn(
            'text-[11px] font-medium uppercase tracking-wider text-muted-foreground',
            tone === 'destructive' && 'text-destructive/70'
          )}
        >
          {title}
        </Label>
        {sub && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {sub}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}
