'use client';

import { Button } from '@/components/ui/button';
import { Eye, Loader2 } from 'lucide-react';
import { useState } from 'react';

interface ImpersonateButtonProps {
  coachId: string;
  hasAuthAccount: boolean;
}

export function ImpersonateButton({ coachId, hasAuthAccount }: ImpersonateButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleImpersonate() {
    setLoading(true);
    await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coachId }),
    });
    window.location.href = '/dashboard';
  }

  if (!hasAuthAccount) return null;

  return (
    <Button variant="outline" size="sm" onClick={handleImpersonate} disabled={loading}>
      {loading ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Eye className="mr-1.5 h-3.5 w-3.5" />
      )}
      Impersonate
    </Button>
  );
}
