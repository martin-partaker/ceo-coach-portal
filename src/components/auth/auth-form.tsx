'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

interface AuthFormProps {
  mode: 'sign-in' | 'sign-up';
}

/**
 * Auth form. Hand-built layout (no shadcn Card primitive) — the shipped
 * Card has only horizontal padding on its content slot, which left the
 * submit button flush against the divider with no breathing room.
 * Explicit padding values keep spacing deterministic.
 */
export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'sign-up') {
        const { error: signUpError } = await authClient.signUp.email({
          email,
          password,
          name: name || email.split('@')[0],
        });
        if (signUpError) {
          setError(signUpError.message ?? 'Failed to create account');
          setLoading(false);
          return;
        }
      } else {
        const { error: signInError } = await authClient.signIn.email({
          email,
          password,
        });
        if (signInError) {
          setError(signInError.message ?? 'Invalid email or password');
          setLoading(false);
          return;
        }
      }
      // Full page navigation to ensure session cookie is sent on first request
      window.location.href = '/dashboard';
    } catch {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <div className="space-y-4 px-6 pb-6 pt-6">
        {mode === 'sign-up' && (
          <div className="space-y-1.5">
            <Label htmlFor="name" className="text-[13px] font-medium">
              Name
            </Label>
            <Input
              id="name"
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="h-10"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-[13px] font-medium">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="h-10"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-[13px] font-medium">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            className="h-10"
          />
        </div>

        {error && (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}

        <Button
          type="submit"
          className="mt-2 h-10 w-full"
          disabled={loading}
          style={{
            background: 'oklch(58% 0.14 258)',
            color: 'white',
          }}
        >
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {mode === 'sign-up' ? 'Create account' : 'Sign in'}
        </Button>
      </div>

      <div className="border-t border-border px-6 py-4 text-center">
        <p className="text-[13px] text-muted-foreground">
          {mode === 'sign-up' ? (
            <>
              Already have an account?{' '}
              <Link
                href="/auth/sign-in"
                className="font-medium text-foreground hover:underline"
              >
                Sign in
              </Link>
            </>
          ) : (
            <>
              Don&apos;t have an account?{' '}
              <Link
                href="/auth/sign-up"
                className="font-medium text-foreground hover:underline"
              >
                Sign up
              </Link>
            </>
          )}
        </p>
      </div>
    </form>
  );
}
