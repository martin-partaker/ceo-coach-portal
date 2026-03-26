'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Loader2,
  Check,
  X,
  CornerDownRight,
  CheckCircle2,
  Circle,
  Ban,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ActionItemsProps {
  cycleId: string;
}

const ownerColors: Record<string, string> = {
  CEO: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  Coach: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  Other: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20',
};

const statusIcons = {
  open: <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />,
  done: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
  dropped: <Ban className="h-3.5 w-3.5 text-muted-foreground/30" />,
};

export function ActionItems({ cycleId }: ActionItemsProps) {
  const utils = trpc.useUtils();
  const items = trpc.actionItems.listForCycle.useQuery({ cycleId });
  const previousOpen = trpc.actionItems.listPreviousOpen.useQuery({ cycleId });

  const [showAdd, setShowAdd] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [newOwner, setNewOwner] = useState<'CEO' | 'Coach' | 'Other'>('CEO');
  const [newDue, setNewDue] = useState('');

  const createItem = trpc.actionItems.create.useMutation({
    onSuccess: () => {
      setNewItem('');
      setNewDue('');
      setShowAdd(false);
      utils.actionItems.listForCycle.invalidate({ cycleId });
    },
  });

  const updateItem = trpc.actionItems.update.useMutation({
    onSuccess: () => {
      utils.actionItems.listForCycle.invalidate({ cycleId });
    },
  });

  const carryForward = trpc.actionItems.carryForward.useMutation({
    onSuccess: () => {
      utils.actionItems.listForCycle.invalidate({ cycleId });
      utils.actionItems.listPreviousOpen.invalidate({ cycleId });
    },
  });

  function handleAdd() {
    if (!newItem.trim()) return;
    createItem.mutate({
      cycleId,
      owner: newOwner,
      item: newItem.trim(),
      dueAt: newDue || null,
    });
  }

  function cycleStatus(id: string, currentStatus: string) {
    const next = currentStatus === 'open' ? 'done' : currentStatus === 'done' ? 'dropped' : 'open';
    updateItem.mutate({ id, status: next as 'open' | 'done' | 'dropped' });
  }

  const openItems = items.data?.filter((i) => i.status === 'open') ?? [];
  const closedItems = items.data?.filter((i) => i.status !== 'open') ?? [];
  const prevOpen = previousOpen.data ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">Action Items</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="pt-4">
        {/* Previous cycle carry-forward */}
        {prevOpen.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Open from previous cycle
            </p>
            <div className="space-y-1.5">
              {prevOpen.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge className={cn('text-[10px] shrink-0', ownerColors[item.owner])}>
                      {item.owner}
                    </Badge>
                    <span className="text-sm truncate">{item.item}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-xs"
                    disabled={carryForward.isPending}
                    onClick={() => carryForward.mutate({ fromItemId: item.id, toCycleId: cycleId })}
                  >
                    {carryForward.isPending ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <CornerDownRight className="mr-1 h-3 w-3" />
                    )}
                    Carry forward
                  </Button>
                </div>
              ))}
            </div>
            <Separator className="mt-4" />
          </div>
        )}

        {/* Add new item form */}
        {showAdd && (
          <div className="mb-4 space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-2">
              <Label className="text-xs">Action item</Label>
              <Input
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                placeholder="Describe the action item..."
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-xs">Owner</Label>
                <Select value={newOwner} onValueChange={(v) => setNewOwner(v as 'CEO' | 'Coach' | 'Other')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CEO">CEO</SelectItem>
                    <SelectItem value="Coach">Coach</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Due date</Label>
                <Input
                  type="date"
                  value={newDue}
                  onChange={(e) => setNewDue(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} disabled={createItem.isPending || !newItem.trim()}>
                {createItem.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                Add
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowAdd(false)}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Current items */}
        {items.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : openItems.length === 0 && closedItems.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No action items yet. Add one above.
          </p>
        ) : (
          <div className="space-y-1">
            {openItems.map((item) => (
              <ActionItemRow key={item.id} item={item} onStatusChange={cycleStatus} />
            ))}
            {closedItems.length > 0 && openItems.length > 0 && (
              <Separator className="my-2" />
            )}
            {closedItems.map((item) => (
              <ActionItemRow key={item.id} item={item} onStatusChange={cycleStatus} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActionItemRow({
  item,
  onStatusChange,
}: {
  item: { id: string; owner: string; item: string; dueAt: string | null; status: string };
  onStatusChange: (id: string, status: string) => void;
}) {
  const isDone = item.status !== 'open';

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted/50',
        isDone && 'opacity-60'
      )}
    >
      <button
        type="button"
        onClick={() => onStatusChange(item.id, item.status)}
        className="shrink-0"
        title={`Status: ${item.status}. Click to change.`}
      >
        {statusIcons[item.status as keyof typeof statusIcons]}
      </button>
      <Badge className={cn('text-[10px] shrink-0', ownerColors[item.owner])}>
        {item.owner}
      </Badge>
      <span className={cn('flex-1 text-sm', isDone && 'line-through')}>
        {item.item}
      </span>
      {item.dueAt && (
        <span className="shrink-0 text-[11px] font-mono text-muted-foreground">
          {new Date(item.dueAt).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}
