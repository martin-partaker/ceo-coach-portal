import { createServerCaller } from '@/lib/trpc/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ZoomEmailSetting } from '@/components/settings/zoom-email-setting';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const api = await createServerCaller();
  const coach = await api.coaches.getMe();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account and integrations.
        </p>
      </div>

      {/* Zoom Integration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Zoom Integration</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <p className="mb-4 text-sm text-muted-foreground">
            Enter the email address associated with your Zoom account.
            This is used to find your cloud-recorded meetings and pull transcripts.
          </p>
          <ZoomEmailSetting currentEmail={coach.zoomUserEmail} />
        </CardContent>
      </Card>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Profile</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <div className="space-y-2 text-sm">
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
    </div>
  );
}
