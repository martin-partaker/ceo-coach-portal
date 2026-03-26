'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  Users,
  LayoutDashboard,
  BookOpen,
  Settings,
  ShieldCheck,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/toolkit', label: 'Coach Toolkit', icon: BookOpen },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const adminItems = [
  { href: '/admin', label: 'Admin', icon: ShieldCheck },
];

interface SidebarProps {
  isSuperAdmin?: boolean;
}

export function Sidebar({ isSuperAdmin }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-sidebar-primary">
            <Users className="h-4 w-4 text-sidebar-primary-foreground" />
          </div>
          <span className="text-sm font-semibold text-sidebar-foreground">
            Coach Portal
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 p-3">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}

        {isSuperAdmin && (
          <>
            <div className="mx-3 my-2 border-t border-sidebar-border" />
            {adminItems.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </Link>
              );
            })}
          </>
        )}
      </nav>
    </aside>
  );
}
