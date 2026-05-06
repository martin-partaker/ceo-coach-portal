import { AuthForm } from '@/components/auth/auth-form';
import { Sparkles } from 'lucide-react';

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
  const isSignUp = path === 'sign-up';

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Subtle radial accent so the page doesn't read as a flat black void.
          Pure CSS — no imagery, no extra requests. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, color-mix(in oklab, oklch(58% 0.14 258), transparent 80%), transparent 60%)',
        }}
      />

      <div className="w-full max-w-sm">
        {/* Brand — match the sidebar's mark for consistency. */}
        <div className="mb-6 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-foreground shadow-sm">
            <Sparkles className="h-5 w-5 text-background" />
          </div>
          <h1 className="mt-5 text-[22px] font-semibold tracking-tight">
            {isSignUp ? 'Create an account' : 'Welcome back'}
          </h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {isSignUp
              ? 'Enter your details to get started'
              : 'Sign in to your account to continue'}
          </p>
        </div>

        <AuthForm mode={isSignUp ? 'sign-up' : 'sign-in'} />

        <p className="mt-6 text-center text-[11px] text-muted-foreground/70">
          CEO Coach Portal · by Partaker
        </p>
      </div>
    </div>
  );
}
