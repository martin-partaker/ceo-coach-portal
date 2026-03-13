import { AuthView } from '@neondatabase/auth/react';

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
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-4">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">CEO Coach Portal</h1>
        <p className="mt-1 text-sm text-gray-500">Executive coaching platform</p>
      </div>
      <AuthView path={path} />
    </main>
  );
}
