'use client';

import { UserButton } from '@neondatabase/auth/react';
import { ThemeToggle } from '@/components/theme-toggle';

interface TopbarProps {
  coachName?: string;
}

export function Topbar({ coachName }: TopbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="text-sm text-muted-foreground">
        {coachName ? (
          <span>
            Welcome back, <span className="font-medium text-foreground">{coachName}</span>
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <UserButton size="icon" />
      </div>
    </header>
  );
}
