'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#0a0a0a', color: '#fafafa' }}>
        <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Something went wrong</h2>
            <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: '#a1a1aa' }}>
              {error.message || 'An unexpected error occurred.'}
            </p>
            <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button
                onClick={reset}
                style={{
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  border: '1px solid #27272a',
                  borderRadius: '0.375rem',
                  background: 'transparent',
                  color: '#fafafa',
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <a
                href="/dashboard"
                style={{
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  border: '1px solid #27272a',
                  borderRadius: '0.375rem',
                  background: 'transparent',
                  color: '#fafafa',
                  textDecoration: 'none',
                }}
              >
                Dashboard
              </a>
            </div>
            {error.digest && (
              <p style={{ marginTop: '1rem', fontSize: '0.7rem', fontFamily: 'monospace', color: '#71717a' }}>
                Error ID: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
