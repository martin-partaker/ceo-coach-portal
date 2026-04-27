'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { InboxDiscoveredForms } from './inbox-discovered-forms';
import { InboxPendingRow } from './inbox-pending-row';

type Tab = 'forms' | 'pending_ceo' | 'pending_cycle' | 'discarded';

export function InboxTabs() {
  const [tab, setTab] = useState<Tab>('forms');
  const counts = trpc.inbox.pendingCounts.useQuery();

  const TABS: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'forms', label: 'Forms' },
    { id: 'pending_ceo', label: 'Unmatched CEO', count: counts.data?.pending_ceo },
    { id: 'pending_cycle', label: 'No cycle', count: counts.data?.pending_cycle },
    { id: 'discarded', label: 'Discarded', count: counts.data?.discarded },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <Button
            key={t.id}
            variant="ghost"
            size="sm"
            onClick={() => setTab(t.id)}
            className={
              tab === t.id
                ? 'rounded-none border-b-2 border-foreground text-foreground'
                : 'rounded-none text-muted-foreground'
            }
          >
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && (
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums">
                {t.count}
              </span>
            )}
          </Button>
        ))}
      </div>

      {tab === 'forms' && <InboxDiscoveredForms />}
      {tab !== 'forms' && <PendingList status={tab} />}
    </div>
  );
}

function PendingList({ status }: { status: 'pending_ceo' | 'pending_cycle' | 'discarded' }) {
  const { data, isLoading } = trpc.inbox.listPending.useQuery({ status });

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin" />;
  if (!data || data.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {data.map((row) => (
        <InboxPendingRow key={row.rawInput.id} row={row} />
      ))}
    </div>
  );
}
