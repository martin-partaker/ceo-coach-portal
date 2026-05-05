import { redirect } from 'next/navigation';
import { Database, Download, Settings as SettingsIcon } from 'lucide-react';
import { createServerCaller } from '@/lib/trpc/server';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const api = await createServerCaller();
  const me = await api.coaches.getMe();
  if (!me.isSuperAdmin) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Super-admin controls for the platform.
        </p>
      </div>

      {/* Data export — one-click ZIP of everything the caller can see
          (CEOs, cycles, journals, transcripts, KPIs, generated reports).
          Scope mirrors the tRPC isUnscopedAdmin rule: an unscoped super
          admin gets every CEO; impersonating a coach narrows to that
          coach's roster. */}
      <SettingsSection
        icon={<Database className="h-4 w-4" />}
        title="Data export"
        description="Download a zip of every CEO, cycle, journal, transcript, KPI value, and generated report on the platform. Useful for archives, audits, or moving data out of the portal."
      >
        <SettingsRow
          label="Export everything"
          description="As a super admin (not impersonating), this includes every CEO across every coach. Impersonating a coach narrows the export to that coach's roster."
        >
          <a
            href="/api/export/zip"
            download
            rel="noreferrer"
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            Download ZIP
          </a>
        </SettingsRow>
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
