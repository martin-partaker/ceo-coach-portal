'use client';

import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc/client';
import { Button } from '@/components/ui/button';
import { ShieldCheck, ShieldOff, Loader2 } from 'lucide-react';

interface AdminToggleButtonProps {
  coachId: string;
  isAdmin: boolean;
  isSelf: boolean;
}

export function AdminToggleButton({ coachId, isAdmin, isSelf }: AdminToggleButtonProps) {
  const router = useRouter();

  const toggleAdmin = trpc.admin.toggleAdmin.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });

  if (isSelf) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => toggleAdmin.mutate({ coachId })}
      disabled={toggleAdmin.isPending}
    >
      {toggleAdmin.isPending ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : isAdmin ? (
        <ShieldOff className="mr-1.5 h-3.5 w-3.5" />
      ) : (
        <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
      )}
      {isAdmin ? 'Remove admin' : 'Make admin'}
    </Button>
  );
}
