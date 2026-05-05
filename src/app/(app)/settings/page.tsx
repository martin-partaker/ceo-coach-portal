import { createServerCaller } from '@/lib/trpc/server';
import {
  CheckCircle2,
  Mail,
  ShieldCheck,
  User,
  Video,
  XCircle,
} from 'lucide-react';
import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { EditableNameField } from '@/components/settings/editable-name-field';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function formatMemberSince(d: Date): string {
  return d.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export default async function SettingsPage() {
  const api = await createServerCaller();
  const coach = await api.coaches.getMe();
  const memberSince = formatMemberSince(coach.createdAt);
  const zoomConnected = !!coach.zoomUserEmail;

  return (
    <div className="space-y-8">
      {/* Page header with avatar + identity */}
      <div className="flex items-center gap-4">
        <CeoAvatar name={coach.name} avatarUrl={null} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {coach.name}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{coach.email}</span>
            <RolePill isSuperAdmin={coach.isSuperAdmin} />
            <span className="text-muted-foreground/70">
              · Member since {memberSince}
            </span>
          </p>
        </div>
      </div>

      {/* Profile section */}
      <SettingsSection
        icon={<User className="h-4 w-4" />}
        title="Profile"
        description="The name and contact details associated with your coach account."
      >
        <SettingsRow
          label="Name"
          description="Shown to your CEOs in coaching update emails and across the portal."
        >
          <EditableNameField initialName={coach.name} />
        </SettingsRow>
        <SettingsRow
          label="Email"
          description="Managed by your sign-in. To change it, update your auth account."
        >
          <span className="font-mono text-sm text-muted-foreground">{coach.email}</span>
        </SettingsRow>
        <SettingsRow
          label="Role"
          description={
            coach.isSuperAdmin
              ? 'Super admins manage every coach and CEO across the platform.'
              : 'Standard coach — you can manage the CEOs assigned to you.'
          }
        >
          <RolePill isSuperAdmin={coach.isSuperAdmin} />
        </SettingsRow>
      </SettingsSection>

      {/* Zoom integration section */}
      <SettingsSection
        icon={<Video className="h-4 w-4" />}
        title="Zoom integration"
        description="Used to fetch coaching session recordings + transcripts so the AI can write follow-up emails grounded in what was actually said."
      >
        <SettingsRow
          label="Status"
          description={
            zoomConnected
              ? 'New session recordings will appear in the cycle workspace under "Zoom Transcript".'
              : 'Without a Zoom email, you can still paste transcripts manually — but auto-import won\'t work.'
          }
        >
          <ZoomStatusPill connected={zoomConnected} />
        </SettingsRow>
        {zoomConnected && (
          <SettingsRow
            label="Zoom email"
            description="The email Zoom uses to identify your account. Managed by your admin — let them know if it needs updating."
          >
            <div className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-mono text-sm">{coach.zoomUserEmail}</span>
              <AdminManagedPill />
            </div>
          </SettingsRow>
        )}
        {!zoomConnected && (
          <SettingsRow
            label="Zoom email"
            description="Ask your admin to set this from the admin Roster. Once set, the cron will start pulling your session recordings."
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="italic">Not configured</span>
              <AdminManagedPill />
            </div>
          </SettingsRow>
        )}
      </SettingsSection>

    </div>
  );
}

/* ─────────────────────── Section primitives ─────────────────────── */

function SettingsSection({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background">
      <header className="border-b border-border bg-muted/20 px-5 py-3">
        <div className="flex items-center gap-2 text-foreground/80">
          {icon}
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid items-start gap-4 px-5 py-4 sm:grid-cols-[200px_1fr]">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="flex min-h-[28px] items-center justify-start sm:justify-end">
        {children}
      </div>
    </div>
  );
}

function RolePill({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium normal-case',
        isSuperAdmin
          ? 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400'
          : 'border-border bg-muted/40 text-foreground/80',
      )}
    >
      {isSuperAdmin ? (
        <>
          <ShieldCheck className="h-2.5 w-2.5" /> Super admin
        </>
      ) : (
        'Coach'
      )}
    </span>
  );
}

function ZoomStatusPill({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-2.5 w-2.5" /> Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
      <XCircle className="h-2.5 w-2.5" /> Not configured
    </span>
  );
}

function AdminManagedPill() {
  return (
    <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
      Admin managed
    </span>
  );
}
