import { authClient } from '@/lib/auth/client';
import { NeonAuthUIProvider } from '@neondatabase/auth/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/components/providers/theme-provider';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CEO Coach Portal',
  description: 'Executive coaching platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <NeonAuthUIProvider
            authClient={authClient}
            redirectTo="/dashboard"
            credentials={{ forgotPassword: true }}
          >
            <TooltipProvider>{children}</TooltipProvider>
          </NeonAuthUIProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
