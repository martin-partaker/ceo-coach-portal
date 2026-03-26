import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FileQuestion, Home } from 'lucide-react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <FileQuestion className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">Page not found</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or has been moved.
          </p>
          <Button className="mt-6" size="sm" asChild>
            <Link href="/dashboard">
              <Home className="mr-1.5 h-4 w-4" />
              Go to dashboard
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
