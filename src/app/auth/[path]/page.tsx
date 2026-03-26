import { AuthView } from '@neondatabase/auth/react';
import { Users } from 'lucide-react';

export const dynamicParams = false;

export async function generateStaticParams() {
  return [{ path: 'sign-in' }, { path: 'sign-up' }, { path: 'sign-out' }];
}

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <Users className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
            CEO Coach Portal
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Executive coaching platform
          </p>
        </div>

        {/* Auth form — AuthView renders its own styled card */}
        <AuthView path={path} />

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Powered by Partaker Coaching
        </p>
      </div>
    </main>
  );
}
