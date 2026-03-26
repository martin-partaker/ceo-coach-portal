'use client';

import { UserButton } from '@neondatabase/auth/react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Separator } from '@/components/ui/separator';

interface TopbarProps {
  coachName?: string;
}

export function Topbar({ coachName }: TopbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-6">
      <div className="text-sm text-muted-foreground">
        {coachName ? (
          <span>
            Welcome back,{' '}
            <span className="font-medium text-foreground">{coachName}</span>
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <Separator orientation="vertical" className="mx-2 h-5" />
        <UserButton size="icon" />
      </div>
    </header>
  );
}
