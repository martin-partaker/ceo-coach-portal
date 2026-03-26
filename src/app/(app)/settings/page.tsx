import { createServerCaller } from '@/lib/trpc/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const api = await createServerCaller();
  const coach = await api.coaches.getMe();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account and integration settings.
        </p>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Profile</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Name</span>
              <span>{coach.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span className="font-mono text-xs">{coach.email}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Zoom Integration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Zoom Integration</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Zoom email</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{coach.zoomUserEmail ?? 'Not set'}</span>
                <Badge variant="outline" className="text-[10px]">Admin managed</Badge>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Your Zoom email is managed by your admin. Contact them if it needs updating.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
