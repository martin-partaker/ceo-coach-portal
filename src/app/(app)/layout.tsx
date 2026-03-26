import { auth } from '@/lib/auth/server';
import { ensureCoach } from '@/lib/ensure-coach';
import { Sidebar } from '@/components/nav/sidebar';
import { Topbar } from '@/components/nav/topbar';
import { redirect } from 'next/navigation';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session } = await auth.getSession();

  if (!session?.user) {
    redirect('/auth/sign-in');
  }

  const coach = await ensureCoach({
    neonAuthUserId: session.user.id,
    name: session.user.name ?? '',
    email: session.user.email ?? '',
  });

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar isSuperAdmin={coach.isSuperAdmin} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar coachName={coach.name} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
