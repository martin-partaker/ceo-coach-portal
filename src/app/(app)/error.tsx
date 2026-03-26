'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import Link from 'next/link';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">Something went wrong</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {error.message || 'An unexpected error occurred. Please try again.'}
          </p>
          <div className="mt-6 flex gap-3">
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Try again
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard">
                <Home className="mr-1.5 h-4 w-4" />
                Dashboard
              </Link>
            </Button>
          </div>
          {error.digest && (
            <p className="mt-4 text-[11px] font-mono text-muted-foreground">
              Error ID: {error.digest}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
