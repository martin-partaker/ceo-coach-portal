import { authClient } from '@/lib/auth/client';
import { NeonAuthUIProvider, UserButton } from '@neondatabase/auth/react';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CEO Coach Portal',
  description: 'Your executive coaching platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <NeonAuthUIProvider
          authClient={authClient}
          redirectTo="/"
          credentials={{ forgotPassword: true }}
        >
          <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
            <span className="font-semibold text-gray-900">CEO Coach Portal</span>
            <UserButton size="icon" />
          </header>
          {children}
        </NeonAuthUIProvider>
      </body>
    </html>
  );
}
