'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  Users,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  Inbox,
  ListChecks,
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { trpc } from '@/lib/trpc/client';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const adminItems = [
  { href: '/admin', label: 'Coaches', icon: ShieldCheck },
  { href: '/admin/ceos', label: 'Roster', icon: Users },
  { href: '/admin/triage', label: 'Triage', icon: ListChecks, showPendingBadge: true },
  { href: '/admin/inbox', label: 'Inbox', icon: Inbox },
];

interface SidebarProps {
  isSuperAdmin?: boolean;
}

export function Sidebar({ isSuperAdmin }: SidebarProps) {
  const pathname = usePathname();

  // Pull pending counts only when this is a super admin viewing the sidebar.
  const pendingQuery = trpc.inbox.pendingCounts.useQuery(undefined, {
    enabled: !!isSuperAdmin,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const pendingTotal =
    (pendingQuery.data?.pending_ceo ?? 0) + (pendingQuery.data?.pending_cycle ?? 0);

  return (
    <aside className="flex h-full w-60 flex-col border-r border-border bg-sidebar">
      {/* Brand */}
      <div className="flex h-14 items-center gap-3 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <Users className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
          Coach Portal
        </span>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4">
        <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Menu
        </p>
        <div className="space-y-1">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </div>

        {isSuperAdmin && (
          <>
            <Separator className="my-4 bg-sidebar-border" />
            <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Administration
            </p>
            <div className="space-y-1">
              {adminItems.map(({ href, label, icon: Icon, showPendingBadge }) => {
                // Longest prefix wins — prevents '/admin' from highlighting
                // while on '/admin/ceos' or '/admin/inbox'.
                const winningHref = [...adminItems]
                  .map((i) => i.href)
                  .sort((a, b) => b.length - a.length)
                  .find((h) => pathname === h || pathname.startsWith(h + '/'));
                const active = winningHref === href;
                const showBadge = showPendingBadge && pendingTotal > 0;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{label}</span>
                    {showBadge && (
                      <span
                        className={cn(
                          'ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                          active
                            ? 'bg-sidebar-accent-foreground/15 text-sidebar-accent-foreground'
                            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        )}
                        aria-label={`${pendingTotal} pending`}
                      >
                        {pendingTotal > 99 ? '99+' : pendingTotal}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </nav>
    </aside>
  );
}
