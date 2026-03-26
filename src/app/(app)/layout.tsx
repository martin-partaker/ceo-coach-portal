import { auth } from '@/lib/auth/server';
import { ensureCoach } from '@/lib/ensure-coach';
import { Sidebar } from '@/components/nav/sidebar';
import { Topbar } from '@/components/nav/topbar';
import { TRPCProvider } from '@/lib/trpc/provider';
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

  let coach;
  try {
    coach = await ensureCoach({
      neonAuthUserId: session.user.id,
      name: session.user.name ?? '',
      email: session.user.email ?? '',
    });
  } catch {
    // If coach creation fails (e.g., email conflict), redirect to sign-in
    redirect('/auth/sign-in');
  }

  return (
    <TRPCProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar isSuperAdmin={coach.isSuperAdmin} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar coachName={coach.name} />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
          </main>
        </div>
      </div>
    </TRPCProvider>
  );
}
