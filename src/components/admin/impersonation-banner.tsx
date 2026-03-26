'use client';

import { useRouter } from 'next/navigation';
import { Eye, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ImpersonationBannerProps {
  coachName: string;
}

export function ImpersonationBanner({ coachName }: ImpersonationBannerProps) {
  const router = useRouter();

  async function stopImpersonating() {
    await fetch('/api/admin/impersonate', { method: 'DELETE' });
    window.location.href = '/admin';
  }

  return (
    <div className="flex items-center justify-between bg-purple-600 px-4 py-2 text-sm text-white">
      <div className="flex items-center gap-2">
        <Eye className="h-4 w-4" />
        <span>
          Impersonating <span className="font-semibold">{coachName}</span> — all actions affect their account
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-white hover:bg-purple-700 hover:text-white"
        onClick={stopImpersonating}
      >
        <X className="mr-1 h-3.5 w-3.5" />
        Stop
      </Button>
    </div>
  );
}
