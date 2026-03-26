import { Card, CardContent } from '@/components/ui/card';
import { BookOpen } from 'lucide-react';

export default function ToolkitPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Coach Toolkit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quick reference materials for coaching sessions.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <BookOpen className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-sm font-medium">Coming soon</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Session checklists, question banks, and templates will appear here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
