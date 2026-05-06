'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { ListChecks, Table } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TriageWalkthrough } from './triage-walkthrough';
import { DataTable } from './data-table';
import { trpc } from '@/lib/trpc/client';

type View = 'triage' | 'all';

interface Props {
  initialView: View;
}

/**
 * Client wrapper for the Data admin page. Renders a two-tab toggle
 * (Triage walkthrough vs. All-data browser) and reflects the selection
 * into ?view= so deep-links survive reloads. The Triage badge is the
 * pending-row count from `inbox.pendingCounts` so the operator can see
 * at a glance whether there's work waiting without switching tabs.
 */
export function DataPageClient({ initialView }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>(initialView);

  // Pending count drives the badge on the Triage tab.
  const counts = trpc.inbox.pendingCounts.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const pending =
    (counts.data?.pending_ceo ?? 0) + (counts.data?.pending_cycle ?? 0);

  // Sync URL with view state without a full navigation.
  useEffect(() => {
    const current = searchParams.get('view');
    if (current === view) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('view', view);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [view, pathname, router, searchParams]);

  const switchTo = useCallback((v: View) => setView(v), []);

  return (
    <div className="space-y-5">
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1">
        <TabButton
          active={view === 'triage'}
          onClick={() => switchTo('triage')}
          icon={<ListChecks className="h-4 w-4" />}
          label="Triage"
          badge={pending > 0 ? (pending > 99 ? '99+' : String(pending)) : null}
        />
        <TabButton
          active={view === 'all'}
          onClick={() => switchTo('all')}
          icon={<Table className="h-4 w-4" />}
          label="All data"
        />
      </div>

      {view === 'triage' ? <TriageWalkthrough /> : <DataTable />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {icon}
      {label}
      {badge && (
        <span
          className={cn(
            'inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
            active
              ? 'bg-background/15 text-background'
              : 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
