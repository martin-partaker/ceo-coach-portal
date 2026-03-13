import { auth } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const { data: session } = await auth.getSession();

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            Welcome back{session?.user?.name ? `, ${session.user.name}` : ''}
          </h1>
          <p className="mt-2 text-gray-600">Your executive coaching portal</p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold text-gray-800">Sessions</h2>
            <p className="mt-2 text-sm text-gray-500">
              Schedule and review your coaching sessions
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold text-gray-800">Goals</h2>
            <p className="mt-2 text-sm text-gray-500">
              Track progress on your leadership goals
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold text-gray-800">Resources</h2>
            <p className="mt-2 text-sm text-gray-500">
              Access your coaching materials and notes
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
