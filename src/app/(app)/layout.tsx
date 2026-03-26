import { auth } from '@/lib/auth/server';
import { ensureCoach } from '@/lib/ensure-coach';
import { Sidebar } from '@/components/nav/sidebar';
import { Topbar } from '@/components/nav/topbar';
import { TRPCProvider } from '@/lib/trpc/provider';
import { ImpersonationBanner } from '@/components/admin/impersonation-banner';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { db } from '@/db';
import { coaches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { IMPERSONATE_COOKIE } from '@/server/api/trpc';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session } = await auth.getSession();

  if (!session?.user) {
    redirect('/auth/sign-in');
  }

  let realCoach;
  try {
    realCoach = await ensureCoach({
      neonAuthUserId: session.user.id,
      name: session.user.name ?? '',
      email: session.user.email ?? '',
    });
  } catch {
    redirect('/auth/sign-in');
  }

  // Check impersonation
  let activeCoach = realCoach;
  let isImpersonating = false;

  if (realCoach.isSuperAdmin) {
    const cookieStore = await cookies();
    const impersonateId = cookieStore.get(IMPERSONATE_COOKIE)?.value;
    if (impersonateId) {
      const [target] = await db
        .select()
        .from(coaches)
        .where(eq(coaches.id, impersonateId))
        .limit(1);
      if (target) {
        activeCoach = target;
        isImpersonating = true;
      }
    }
  }

  return (
    <TRPCProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar isSuperAdmin={realCoach.isSuperAdmin} />
        <div className="flex flex-1 flex-col overflow-hidden">
          {isImpersonating && (
            <ImpersonationBanner coachName={activeCoach.name} />
          )}
          <Topbar coachName={activeCoach.name} />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
          </main>
        </div>
      </div>
    </TRPCProvider>
  );
}
