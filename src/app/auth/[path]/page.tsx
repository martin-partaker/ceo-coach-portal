import { AuthForm } from '@/components/auth/auth-form';

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
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-[400px]">
        {/* Brand */}
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-foreground">
            <span className="text-lg font-bold text-background">C</span>
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">
            {path === 'sign-up' ? 'Create an account' : 'Welcome back'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {path === 'sign-up'
              ? 'Enter your details to get started'
              : 'Sign in to your account to continue'}
          </p>
        </div>

        <AuthForm mode={path === 'sign-up' ? 'sign-up' : 'sign-in'} />

        <p className="mt-8 text-center text-xs text-muted-foreground">
          CEO Coach Portal by Partaker
        </p>
      </div>
    </div>
  );
}
